// The Viewer's map for the interface packs: MapLibre GL with the same maps as
// the built-in Viewer (OpenFreeMap's street map, Google satellite on request,
// the same label rule), the drive's route and the car's arrow. A pack puts it
// in its own page and colours it with CSS variables:
//
//   --vm-bg            the map's background while tiles load
//   --vm-btn-bg        the round buttons (re-center, heading, map / satellite)
//   --vm-btn-fg
//   --vm-btn-border
//   --vm-btn-active    a button that is on
//   --vm-radius        the buttons' corner radius
//
//   const map = createViewerMap(el, { dark: true });
//   map.addRoute(clipKey, records);   // records with lat, lon, pilot
//   map.setPosition(record);          // lat, lon, heading at the playhead
//   map.destroy();
//
// Search by place: with `onPlaceClip`, a pin button lets the next tap on the
// map list every clip recorded near that spot (any day, any vehicle; from
// the speed index's GPS points, /api/places/near), and picking one calls
// onPlaceClip({ vehicle, day, clip, second, path }) so the pack opens it.
// `clock("HH-MM-SS")` formats the times as the pack does.
//
// The street-map / satellite choice and Map Labels are the Viewer's own
// settings (/api/studio/settings), so a choice made in one interface holds
// in the others. Light or dark follows the pack's look (`dark`).

import '/shared/mapProviders.js';
import { timeAfter } from '/web/scrub.js';

// MapLibre (1.6 MB, about 400 KB compressed) is loaded only when the map is
// needed: a route with GPS has come and the map is on screen (or nearly). A
// clip without GPS, a map scrolled away on a phone, or a page left before
// then never loads it.
let createMap, htmlMarker, drawRoute, boundsOf, fitTo, centreOn, toLngLat, toRasterZoom;
let mapLib = null;
function loadMapLib() {
  if (!mapLib) {
    // MapLibre's own stylesheet (markers, controls), as the built-in Viewer has
    if (!document.getElementById('vm-lib-css')) {
      const link = document.createElement('link');
      link.id = 'vm-lib-css';
      link.rel = 'stylesheet';
      link.href = '/studio/vendor/maplibre/maplibre-gl.css';
      document.head.appendChild(link);
    }
    mapLib = import('/studio/scripts/ui/mapGl.js').then((m) => {
      ({ createMap, htmlMarker, drawRoute, boundsOf, fitTo, centreOn, toLngLat, toRasterZoom } = m);
    });
  }
  return mapLib;
}

const P = () => self.MapProviders;
const AUTOPILOT = '#22c55e';
const MANUAL = '#3b82f6';
const SATELLITE = 'google-satellite';

const ICON = {
  centre: '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path fill="currentColor" d="M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8zm8.94 3A9 9 0 0 0 13 3.06V1h-2v2.06A9 9 0 0 0 3.06 11H1v2h2.06A9 9 0 0 0 11 20.94V23h2v-2.06A9 9 0 0 0 20.94 13H23v-2h-2.06zM12 19a7 7 0 1 1 0-14 7 7 0 0 1 0 14z"/></svg>',
  compass: '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path fill="currentColor" d="M12 2 7 20l5-3 5 3z"/></svg>',
  pin: '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path fill="currentColor" d="M12 2a7 7 0 0 0-7 7c0 5.2 7 13 7 13s7-7.8 7-13a7 7 0 0 0-7-7zm0 9.5A2.5 2.5 0 1 1 12 6.5a2.5 2.5 0 0 1 0 5z"/></svg>',
  layers: '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path fill="currentColor" d="m12 3 10 5-10 5L2 8zm-7.6 8.8L12 15.6l7.6-3.8L22 13l-10 5-10-5zm0 5L12 20.6l7.6-3.8L22 18l-10 5-10-5z"/></svg>'
};

const CSS = `
.vm{position:relative;overflow:hidden;background:var(--vm-bg,#1b2230);isolation:isolate}
.vm .vm-canvas{position:absolute;inset:0}
.vm-btns{position:absolute;right:8px;bottom:8px;display:flex;gap:6px;z-index:2}
.vm-btn{width:32px;height:32px;display:grid;place-items:center;padding:0;cursor:pointer;
  border-radius:var(--vm-radius,8px);border:1px solid var(--vm-btn-border,rgba(255,255,255,.18));
  background:var(--vm-btn-bg,rgba(11,14,19,.85));color:var(--vm-btn-fg,#e6e9ef)}
.vm-btn[aria-pressed="true"]{color:var(--vm-btn-active,#5ee9a0)}
.vm-btn[hidden]{display:none}
.vm-btn svg{transition:transform .2s}
.vm-note{position:absolute;inset:0;display:grid;place-items:center;padding:12px;text-align:center;
  font-size:12px;color:var(--vm-btn-fg,#e6e9ef);background:var(--vm-bg,#1b2230);z-index:1}
.vm-note[hidden]{display:none}
.vm .maplibregl-ctrl-attrib.maplibregl-compact{margin:0 0 8px 8px;font-size:10px}
.vm-arrow{pointer-events:none}
.vm-arrow img{display:block;width:64px;height:64px}
.vm.vm-picking .vm-canvas canvas{cursor:crosshair}
.vm-hint{position:absolute;left:8px;right:8px;top:8px;z-index:3;padding:6px 10px;border-radius:var(--vm-radius,8px);
  font:600 12px/1.3 system-ui,sans-serif;text-align:center;background:var(--vm-btn-bg,rgba(11,14,19,.88));color:var(--vm-btn-fg,#e6e9ef)}
.vm-places{position:absolute;left:8px;right:8px;top:8px;max-height:calc(100% - 56px);z-index:3;display:flex;flex-direction:column;
  border-radius:var(--vm-radius,8px);border:1px solid var(--vm-btn-border,rgba(255,255,255,.18));
  background:var(--vm-btn-bg,rgba(11,14,19,.92));color:var(--vm-btn-fg,#e6e9ef);font:13px/1.35 system-ui,sans-serif;overflow:hidden}
.vm-places header{display:flex;align-items:center;gap:8px;padding:8px 10px;font-weight:600;border-bottom:1px solid var(--vm-btn-border,rgba(255,255,255,.18))}
.vm-places header span{flex:1}
.vm-places header button{all:unset;cursor:pointer;padding:0 4px;font-size:16px;line-height:1}
.vm-places ol{list-style:none;margin:0;padding:4px 0;overflow:auto}
.vm-places li button{all:unset;box-sizing:border-box;display:flex;gap:8px;width:100%;padding:6px 10px;cursor:pointer}
.vm-places li button:hover,.vm-places li button:focus-visible{background:rgba(255,255,255,.08)}
.vm-places li b{font-variant-numeric:tabular-nums}
.vm-places li span{opacity:.7;margin-left:auto;white-space:nowrap}
.vm-places p{margin:0;padding:10px}
.vm-pin{all:unset;box-sizing:border-box;width:16px;height:16px;border-radius:50%;border:2px solid #fff;box-shadow:0 1px 4px rgba(0,0,0,.5);cursor:pointer}
.vm-pin:focus-visible{outline:3px solid #fff}
.vm-place{display:flex;align-items:center;gap:4px;pointer-events:none;font:700 11px/1.2 system-ui,sans-serif;color:#fff;text-shadow:0 1px 2px #000,0 0 3px #000}
.vm-place i{width:10px;height:10px;border-radius:3px;background:#ffd34a;border:2px solid #fff;flex:none}
.vm-chips{display:flex;flex-wrap:wrap;gap:6px;justify-content:center;margin-top:6px}
.vm-chips button,.vm-places header button[data-save],.vm-save button{all:unset;cursor:pointer;padding:3px 9px;border-radius:999px;border:1px solid var(--vm-btn-border,rgba(255,255,255,.3));font-weight:600;font-size:12px}
.vm-save{display:flex;gap:6px;padding:6px 10px}
.vm-save input{flex:1;min-width:0;padding:4px 8px;border-radius:6px;border:1px solid var(--vm-btn-border,rgba(255,255,255,.3));background:transparent;color:inherit;font:inherit}
.vm-spot{width:14px;height:14px;border-radius:50%;background:var(--vm-btn-active,#5ee9a0);border:2px solid #fff;box-shadow:0 0 0 6px rgba(94,233,160,.25)}
`;

function addCss() {
  if (document.getElementById('vm-css')) return;
  const style = document.createElement('style');
  style.id = 'vm-css';
  style.textContent = CSS;
  document.head.appendChild(style);
}

let settingsJob = null;
function settings() {
  settingsJob ||= fetch('/api/studio/settings', { credentials: 'same-origin' }).then((r) => (r.ok ? r.json() : {})).catch(() => ({}));
  return settingsJob;
}

function saveSetting(key, value) {
  settingsJob = settings().then((all) => ({ ...all, [key]: value }));
  return fetch('/api/studio/settings', {
    method: 'POST', credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'sentry-six-manager' },
    body: JSON.stringify({ key, value })
  }).catch(() => {});
}

// Each pack names the Autopilot state its own way ('off', 'Off', '', 'FSD',
// 'Autosteer', 0..3): anything but none counts as engaged (the green line).
function engaged(r) {
  const v = r.pilot ?? r.autopilot;
  if (typeof v === 'number') return v > 0;
  return typeof v === 'string' && v !== '' && v.toLowerCase() !== 'off' && v !== '0';
}

const fin = (n) => typeof n === 'number' && Number.isFinite(n);
const hasFix = (r) => r && fin(r.lat) && fin(r.lon) && Math.abs(r.lat) <= 90 && Math.abs(r.lon) <= 180 && (Math.abs(r.lat) > 0.001 || Math.abs(r.lon) > 0.001);

/**
 * @param {HTMLElement} container - the map fills it (give it a size)
 * @param {{dark?: boolean, colors?: {manual?: string, autopilot?: string}, noGps?: string}} [opts]
 */
export function createViewerMap(container, opts = {}) {
  addCss();
  container.classList.add('vm');
  const noGpsText = opts.noGps || 'No GPS in this clip';
  container.innerHTML = '<div class="vm-note" hidden></div>';
  const note = container.querySelector('.vm-note');
  // what the map is to show, kept until it is there
  const routes = new Map();
  let pos = null;
  let pins = null; // [pins, options] kept until the map is there
  let dark = !!opts.dark;
  let real = null;
  let dead = false;
  let onScreen = typeof IntersectionObserver !== 'function';
  const hasGps = () => hasFix(pos) || Boolean(pins?.[0]?.length) || [...routes.values()].some((records) => (records || []).some(hasFix));
  const io = onScreen ? null : new IntersectionObserver((entries) => {
    onScreen = entries.some((e) => e.isIntersecting);
    maybeLoad();
  }, { rootMargin: '300px' });
  io?.observe(container);
  function maybeLoad() {
    note.textContent = noGpsText;
    note.hidden = hasGps() || routes.size === 0;
    if (real || dead || !onScreen || !hasGps()) return;
    loadMapLib().then(() => {
      if (real || dead) return;
      io?.disconnect();
      real = buildViewerMap(container, { ...opts, dark });
      for (const [key, records] of routes) real.addRoute(key, records);
      if (pos) real.setPosition(pos);
      if (pins) real.setPins(...pins);
    }).catch(() => {
      note.textContent = 'The map could not be loaded.';
      note.hidden = false;
    });
  }
  return {
    addRoute(key, records) { if (real) real.addRoute(key, records); else { routes.set(key, records); maybeLoad(); } },
    clearRoute() { if (real) real.clearRoute(); else { routes.clear(); pos = null; maybeLoad(); } },
    setPosition(r) { if (real) real.setPosition(r); else { pos = r; if (hasFix(r)) maybeLoad(); } },
    setDark(on) { dark = !!on; real?.setDark(on); },
    /** Pins: [{ lat, lon, color, title }] and { onPick(pin) }; the map fits them when it has no route. */
    setPins(list, pinOpts = {}) { if (real) real.setPins(list, pinOpts); else { pins = [list || [], pinOpts]; maybeLoad(); } },
    resize() { real?.resize(); },
    destroy() {
      dead = true;
      io?.disconnect();
      if (real) real.destroy(); else container.innerHTML = '';
    }
  };
}

// The map itself, once MapLibre is loaded (see createViewerMap).
function buildViewerMap(container, opts = {}) {
  container.innerHTML = `<div class="vm-canvas"></div>
    <div class="vm-note" hidden></div>
    <div class="vm-btns">
      <button type="button" class="vm-btn" data-vm="centre" title="Follow the car" aria-label="Follow the car" hidden>${ICON.centre}</button>
      <button type="button" class="vm-btn" data-vm="heading" title="Heading up (tap for north up)" aria-label="Heading up" aria-pressed="true">${ICON.compass}</button>
      ${opts.onPlaceClip ? `<button type="button" class="vm-btn" data-vm="place" title="Find clips recorded at a place" aria-label="Find clips recorded at a place" aria-pressed="false">${ICON.pin}</button>` : ''}
      <button type="button" class="vm-btn" data-vm="layers" title="Satellite" aria-label="Satellite" aria-pressed="false">${ICON.layers}</button>
    </div>`;
  const note = container.querySelector('.vm-note');
  const btn = (k) => container.querySelector(`[data-vm="${k}"]`);
  const colors = { manual: MANUAL, autopilot: AUTOPILOT, ...(opts.colors || {}) };
  const noGpsText = opts.noGps || 'No GPS in this clip';

  let map;
  try {
    map = createMap(container.querySelector('.vm-canvas'), { dragPan: true });
    map.scrollZoom.setWheelZoomRate?.(1 / 300);
  } catch (err) {
    note.textContent = 'The map needs WebGL, which this browser has turned off.';
    note.hidden = false;
    const dead = () => {};
    return { addRoute: dead, clearRoute: dead, setPosition: dead, setDark: dead, resize: dead, destroy: () => { container.innerHTML = ''; } };
  }

  let dark = !!opts.dark;
  let provider = P().DEFAULT_PROVIDER_ID;
  let labels = P().DEFAULT_LABELS_ENABLED;
  let applied = null;
  let headingUp = true;
  let follow = true;
  let bearing = 0; // unwrapped, smoothed the short way round
  let arrow = null;
  let last = null; // last position with a fix
  let placed = false; // the camera has been put on the drive once
  const routes = new Map(); // key -> points
  let route = null;
  let destroyed = false;

  function applyLabels() {
    let layers;
    try { layers = map.getStyle()?.layers || []; } catch { return; }
    for (const layer of layers) {
      if (layer.id.startsWith('sx-')) continue;
      const want = P().isLayerVisible(layer, labels) ? 'visible' : 'none';
      if ((layer.layout?.visibility || 'visible') !== want) {
        try { map.setLayoutProperty(layer.id, 'visibility', want); } catch { /* gone mid-swap */ }
      }
    }
  }
  map.on('style.load', applyLabels);

  // Satellite failing to load falls back to the street map for this page
  let satErrors = 0;
  let satLoaded = false;
  map.on('sourcedata', (e) => { if (e.sourceId === P().RASTER_SOURCE_ID && e.tile) satLoaded = true; });
  map.on('error', (e) => {
    if (e?.sourceId !== P().RASTER_SOURCE_ID || satLoaded || provider !== SATELLITE) return;
    if (++satErrors >= 3) { provider = P().DEFAULT_PROVIDER_ID; applyStyle(); }
  });

  function applyStyle() {
    const key = `${provider}|${dark}`;
    btn('layers').setAttribute('aria-pressed', String(provider === SATELLITE));
    if (key === applied) return;
    applied = key;
    try { map.setStyle(P().getStyle(provider, { dark }), { diff: false }); } catch (err) { console.warn('[map]', err); }
  }

  settings().then((all) => {
    if (destroyed) return;
    provider = P().getProvider(all.mapTileProvider).id;
    labels = all[P().LABELS_SETTING_KEY] === undefined || all[P().LABELS_SETTING_KEY] === null ? P().DEFAULT_LABELS_ENABLED : !!all[P().LABELS_SETTING_KEY];
    applyStyle();
  });

  function drawAllRoutes() {
    const all = [...routes.entries()].sort(([a], [b]) => String(a).localeCompare(String(b))).flatMap(([, pts]) => pts);
    route?.remove();
    route = null;
    if (all.length < 2) return;
    const segments = [];
    let cur = null;
    for (const p of all) {
      const color = p.ap ? colors.autopilot : colors.manual;
      if (!cur || cur.color !== color) {
        const prev = cur?.coords[cur.coords.length - 1];
        cur = { color, coords: prev ? [prev] : [] };
        segments.push(cur);
      }
      cur.coords.push([p.lat, p.lon]);
    }
    route = drawRoute(map, 'sx-route', segments);
    if (!placed && !last) fitTo(map, boundsOf(all), { padding: 24, maxZoom: 16 });
  }

  function showNote() {
    note.textContent = noGpsText;
    note.hidden = !!(last || pinMarkers.length || routes.size && [...routes.values()].some((pts) => pts.length));
  }

  function setFollow(on) {
    follow = on;
    btn('centre').hidden = on;
    if (on && last) centreOn(map, [last.lat, last.lon], undefined, { animate: true, bearing: headingUp ? bearing : 0 });
  }
  map.on('dragstart', () => setFollow(false));

  btn('centre').addEventListener('click', () => setFollow(true));
  btn('heading').addEventListener('click', () => {
    headingUp = !headingUp;
    const b = btn('heading');
    b.setAttribute('aria-pressed', String(headingUp));
    b.title = headingUp ? 'Heading up (tap for north up)' : 'North up (tap for heading up)';
    b.setAttribute('aria-label', headingUp ? 'Heading up' : 'North up');
    map.easeTo({ bearing: headingUp ? bearing : 0, duration: 300 });
  });
  btn('layers').addEventListener('click', () => {
    provider = provider === SATELLITE ? P().DEFAULT_PROVIDER_ID : SATELLITE;
    satErrors = 0;
    satLoaded = false;
    saveSetting('mapTileProvider', provider);
    applyStyle();
  });
  // ---- pins (the event map) ----
  let pinMarkers = [];
  function setPins(list, { onPick = null } = {}) {
    for (const m of pinMarkers) m.remove();
    pinMarkers = [];
    const pts = [];
    for (const p of list || []) {
      if (!hasFix(p)) continue;
      const el = document.createElement('button');
      el.type = 'button';
      el.className = 'vm-pin';
      el.style.background = p.color || '#ff5d5d';
      el.title = p.title || '';
      el.setAttribute('aria-label', p.title || 'Event');
      if (onPick) el.addEventListener('click', (e) => { e.stopPropagation(); onPick(p); });
      const marker = htmlMarker(map, [p.lat, p.lon], { html: '' });
      marker.getElement().appendChild(el);
      pinMarkers.push(marker);
      pts.push([p.lat, p.lon]);
    }
    showNote();
    if (pts.length && !routes.size && !last) fitTo(map, boundsOf(pts), { padding: 40, maxZoom: 15 });
  }

  // ---- saved places: labelled on the map, and places the search can use ----
  let places = [];
  let placeMarkers = [];
  async function loadPlaces() {
    try {
      const r = await fetch('/api/places', { credentials: 'same-origin' });
      places = r.ok ? (await r.json()).places || [] : [];
    } catch { places = []; }
    if (destroyed) return;
    for (const m of placeMarkers) m.remove();
    placeMarkers = places.map((p) => htmlMarker(map, [p.lat, p.lon], { html: `<div class="vm-place"><i></i><span>${esc(p.name)}</span></div>` }));
  }
  if (opts.places !== false) loadPlaces();

  // ---- search by place ----
  let picking = false;
  let spot = null;
  let panel = null;
  const clock = opts.clock || ((hms) => { const [h, m, sec] = hms.split('-').map(Number); return `${h % 12 || 12}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`; });
  const dayText = (d) => { try { return new Date(`${d}T12:00:00`).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' }); } catch { return d; } };
  const esc = (t) => String(t).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  function closePlaces() {
    panel?.remove();
    panel = null;
    spot?.remove();
    spot = null;
  }
  function setPicking(on) {
    picking = on;
    container.classList.toggle('vm-picking', on);
    btn('place')?.setAttribute('aria-pressed', String(on));
    container.querySelector('.vm-hint')?.remove();
    if (on) {
      closePlaces();
      container.insertAdjacentHTML('beforeend', `<div class="vm-hint" role="status">Tap a place on the map to find clips recorded there${places.length ? `<span class="vm-chips">${places.map((p, i) => `<button type="button" data-place="${i}">${esc(p.name)}</button>`).join('')}</span>` : ''}</div>`);
      container.querySelector('.vm-hint').addEventListener('click', (e) => {
        const b = e.target.closest('[data-place]');
        if (b) { const p = places[Number(b.dataset.place)]; if (p) findAt(p.lat, p.lon, p.name); }
      });
    }
  }
  async function findAt(lat, lon, placeLabel = null) {
    setPicking(false);
    spot = htmlMarker(map, [lat, lon], { html: '<div class="vm-spot"></div>' });
    centreOn(map, [lat, lon], undefined, { animate: true });
    panel = document.createElement('div');
    panel.className = 'vm-places';
    panel.innerHTML = `<header><span>Looking for clips here…</span>${placeLabel ? '' : '<button type="button" data-save title="Save this place with a name">Save place</button>'}<button type="button" data-close aria-label="Close">×</button></header>
      <form class="vm-save" hidden><input type="text" maxlength="60" placeholder="Name, like Home or Work" aria-label="Name of this place" required><button type="submit">Save</button></form>`;
    panel.querySelector('[data-close]').onclick = closePlaces;
    const form = panel.querySelector('.vm-save');
    panel.querySelector('[data-save]')?.addEventListener('click', () => { form.hidden = false; form.querySelector('input').focus(); });
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      try {
        const r = await fetch('/api/places', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'sentry-six-manager' }, body: JSON.stringify({ name: form.querySelector('input').value, lat, lon }) });
        if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || 'Not saved.');
        form.hidden = true;
        panel.querySelector('[data-save]')?.remove();
        loadPlaces();
      } catch (err) { form.querySelector('input').setCustomValidity(err.message); form.querySelector('input').reportValidity(); setTimeout(() => form.querySelector('input').setCustomValidity(''), 3000); }
    });
    container.appendChild(panel);
    let data;
    try {
      const r = await fetch(`/api/places/near?lat=${lat.toFixed(5)}&lon=${lon.toFixed(5)}&radius=150`, { credentials: 'same-origin' });
      data = await r.json();
      if (!r.ok) throw new Error(data.error || 'The search failed.');
    } catch (err) {
      if (panel) panel.querySelector('header span').textContent = err.message || 'The search failed.';
      return;
    }
    if (!panel) return;
    const list = data.results || [];
    const vehiclesShown = new Set(list.map((x) => x.vehicle)).size > 1;
    panel.querySelector('header span').textContent = `${list.length ? `${list.length} clip${list.length === 1 ? '' : 's'}` : 'No clips'} within ${data.radius} m${placeLabel ? ` of ${placeLabel}` : ''}`;
    if (!list.length) {
      panel.insertAdjacentHTML('beforeend', '<p>Only footage with GPS that the speed index has read is searched; new footage is read in the background.</p>');
      return;
    }
    const ol = document.createElement('ol');
    ol.innerHTML = list.map((x, i) => {
      const at = timeAfter(x.clip, x.second);
      return `<li><button type="button" data-i="${i}"><b>${esc(dayText(x.day))}</b> ${esc(at ? clock(at) : x.clip)}<span>${vehiclesShown ? `${esc(x.vehicleName)} · ` : ''}${x.metres} m</span></button></li>`;
    }).join('');
    ol.addEventListener('click', (e) => {
      const b = e.target.closest('button[data-i]');
      if (b) opts.onPlaceClip(list[Number(b.dataset.i)]);
    });
    panel.appendChild(ol);
  }
  btn('place')?.addEventListener('click', () => setPicking(!picking));
  map.on('click', (e) => { if (picking) findAt(e.lngLat.lat, e.lngLat.lng); });

  map.on('rotate', () => {
    const svg = btn('heading').querySelector('svg');
    if (svg) svg.style.transform = `rotate(${-map.getBearing()}deg)`;
  });

  return {
    /** The route of one clip (records with lat, lon and pilot / autopilot). */
    addRoute(key, records) {
      const pts = (records || []).filter(hasFix).map((r) => ({ lat: r.lat, lon: r.lon, ap: engaged(r) }));
      routes.set(key, pts);
      drawAllRoutes();
      showNote();
    },
    clearRoute() {
      routes.clear();
      drawAllRoutes();
      placed = false;
      last = null;
      arrow?.remove();
      arrow = null;
      showNote();
    },
    /** The car at the playhead: a record with lat, lon, heading (or null). */
    setPosition(r) {
      if (!hasFix(r)) {
        showNote();
        return;
      }
      const target = (((fin(r.heading) ? r.heading : 0) % 360) + 360) % 360;
      let delta = target - (bearing % 360);
      if (delta > 180) delta -= 360;
      if (delta < -180) delta += 360;
      bearing += delta;
      const moved = !last || last.lat !== r.lat || last.lon !== r.lon || Math.abs(delta) > 0.05;
      last = { lat: r.lat, lon: r.lon };
      showNote();
      if (!arrow) {
        arrow = htmlMarker(map, [r.lat, r.lon], { className: 'vm-arrow', html: '<img src="/assets/arrow.png" alt="">', rotationAlignment: 'map' });
      } else if (moved) {
        arrow.setLngLat(toLngLat([r.lat, r.lon]));
      }
      arrow.setRotation(bearing);
      if (!placed) {
        placed = true;
        centreOn(map, [r.lat, r.lon], Math.max(16, toRasterZoom(map.getZoom())), { bearing: headingUp ? bearing : 0 });
        return;
      }
      if (follow && moved) centreOn(map, [r.lat, r.lon], undefined, { bearing: headingUp ? bearing : 0 });
    },
    /** Light or dark street map (the pack's own theme switch). */
    setDark(on) {
      dark = !!on;
      applyStyle();
    },
    setPins,
    resize() { map.resize(); },
    destroy() {
      destroyed = true;
      try { map.remove(); } catch { /* gone */ }
      container.innerHTML = '';
    }
  };
}
