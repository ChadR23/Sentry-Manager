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
// The street-map / satellite choice and Map Labels are the Viewer's own
// settings (/api/studio/settings), so a choice made in one interface holds
// in the others. Light or dark follows the pack's look (`dark`).

import { createMap, htmlMarker, drawRoute, boundsOf, fitTo, centreOn, toLngLat, toRasterZoom } from '/studio/scripts/ui/mapGl.js';
import '/shared/mapProviders.js';

const P = () => self.MapProviders;
const AUTOPILOT = '#22c55e';
const MANUAL = '#3b82f6';
const SATELLITE = 'google-satellite';

const ICON = {
  centre: '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path fill="currentColor" d="M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8zm8.94 3A9 9 0 0 0 13 3.06V1h-2v2.06A9 9 0 0 0 3.06 11H1v2h2.06A9 9 0 0 0 11 20.94V23h2v-2.06A9 9 0 0 0 20.94 13H23v-2h-2.06zM12 19a7 7 0 1 1 0-14 7 7 0 0 1 0 14z"/></svg>',
  compass: '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path fill="currentColor" d="M12 2 7 20l5-3 5 3z"/></svg>',
  layers: '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path fill="currentColor" d="m12 3 10 5-10 5L2 8zm-7.6 8.8L12 15.6l7.6-3.8L22 13l-10 5-10-5zm0 5L12 20.6l7.6-3.8L22 18l-10 5-10-5z"/></svg>'
};

const CSS = `
.vm{position:relative;overflow:hidden;background:var(--vm-bg,#1b2230);isolation:isolate}
.vm-canvas{position:absolute;inset:0}
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
.vm-arrow img{display:block;width:64px;height:64px}
`;

function addCss() {
  if (document.getElementById('vm-css')) return;
  // MapLibre's own stylesheet (markers, controls), as the built-in Viewer has
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = '/studio/vendor/maplibre/maplibre-gl.css';
  document.head.appendChild(link);
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
  container.innerHTML = `<div class="vm-canvas"></div>
    <div class="vm-note" hidden></div>
    <div class="vm-btns">
      <button type="button" class="vm-btn" data-vm="centre" title="Follow the car" aria-label="Follow the car" hidden>${ICON.centre}</button>
      <button type="button" class="vm-btn" data-vm="heading" title="Heading up (tap for north up)" aria-label="Heading up" aria-pressed="true">${ICON.compass}</button>
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
    note.hidden = !!(last || routes.size && [...routes.values()].some((pts) => pts.length));
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
    resize() { map.resize(); },
    destroy() {
      destroyed = true;
      try { map.remove(); } catch { /* gone */ }
      container.innerHTML = '';
    }
  };
}
