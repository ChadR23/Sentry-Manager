// Settings > Places, the same in every interface: the saved places (Home,
// Work) that tag Sentry and Saved events "at Home" on the Footage page, with
// their radius; where the car parks most (from the events' own positions,
// worked out on the server), this device's location, or coordinates pasted
// from a maps app, or a click on the map (the app's own MapLibre map,
// web/viewerMap.js, with the Viewer's map tiles): the saved places with their
// radius, the suggestions with their count, and a dropped pin that can be
// set as Home or Work (moving the one there is) or saved with a name.
// Nothing else here asks any service outside the server.
//
//   const p = createPlacesSettings(el, {
//     cls: { btn, primary, danger, input, muted },  // the interface's own classes
//     toast: (message, bad) => …,
//     confirm: ({ title, body, ok }) => Promise<boolean>
//   });
//   p.destroy();

const STYLE = `
.sentry-pl.pl-ro [data-add],.sentry-pl.pl-ro button:not(.vm-btn),.sentry-pl.pl-ro [data-addsec]{display:none!important}
.sentry-pl{display:flex;flex-direction:column;gap:18px;font-size:14px;line-height:1.45;container-type:inline-size}
.sentry-pl .pl-cols,.sentry-pl .pl-col{display:flex;flex-direction:column;gap:18px;min-width:0}
@container (min-width: 940px){.sentry-pl .pl-cols{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1.2fr);gap:28px;align-items:start}}
.sentry-pl .pl-map{height:400px;border-radius:12px;overflow:hidden;border:1px solid rgba(127,127,127,.3);
  --vm-bg:#1b2230;--vm-btn-bg:rgba(11,14,19,.86);--vm-btn-fg:#e6e9ef;--vm-btn-border:rgba(255,255,255,.18);--vm-btn-active:#5ee9a0}
.sentry-pl .pl-map.pl-light{--vm-bg:#e6ebf0;--vm-btn-bg:rgba(255,255,255,.94);--vm-btn-fg:#1b1f22;--vm-btn-border:rgba(0,0,0,.18);--vm-btn-active:#0d8f8f}
@container (max-width: 600px){.sentry-pl .pl-map{height:300px}}
.sentry-pl .pl-bar{display:flex;flex-wrap:wrap;gap:6px 10px;align-items:center;min-height:32px;margin:0 0 8px}
.sentry-pl .pl-bar .pl-grow{flex:1 1 200px}
.sentry-pl li[data-place],.sentry-pl li[data-sugg-i]{cursor:pointer}
.sentry-pl li[data-place] form,.sentry-pl li[data-sugg-i] form{cursor:auto}
.sentry-pl .pl-sugg{width:12px;height:12px;border-radius:50%;background:#6aa9ff;border:2px solid #fff;box-shadow:0 0 0 1px rgba(0,0,0,.25);flex:none}
.sentry-pl h3{margin:0 0 6px;font-size:15px}
.sentry-pl p{margin:0}
.sentry-pl ul{list-style:none;margin:0;padding:0;display:flex;flex-direction:column}
.sentry-pl li{display:flex;flex-wrap:wrap;gap:8px 12px;align-items:center;padding:10px 0;border-top:1px solid rgba(127,127,127,.22)}
.sentry-pl li:first-child{border-top:0}
.sentry-pl .pl-grow{flex:1 1 220px;min-width:0}
.sentry-pl .pl-acts{display:flex;flex-wrap:wrap;gap:6px}
.sentry-pl .pl-mono{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12.5px;overflow-wrap:anywhere}
.sentry-pl .pl-dim{opacity:.72}
.sentry-pl .pl-tag{display:inline-block;font-size:11px;font-weight:700;padding:1px 8px;border-radius:999px;background:rgba(255,211,74,.24);white-space:nowrap;vertical-align:1px}
.sentry-pl .pl-pin{width:10px;height:10px;border-radius:3px;background:#ffd34a;border:2px solid #fff;box-shadow:0 0 0 1px rgba(0,0,0,.25);flex:none}
.sentry-pl .pl-edit,.sentry-pl .pl-add{display:flex;flex-wrap:wrap;gap:10px;align-items:flex-end;width:100%}
.sentry-pl .pl-edit[hidden],.sentry-pl .pl-add [hidden]{display:none}
.sentry-pl label.pl-f{display:flex;flex-direction:column;gap:4px;font-size:13px;font-weight:600;flex:1 1 160px;min-width:0}
.sentry-pl label.pl-f.pl-r{flex:0 1 120px}
.sentry-pl label.pl-f input{width:100%;box-sizing:border-box;min-width:0}
.sentry-pl .pl-note{font-size:12.5px}
.sentry-pl .pl-err{color:#e5484d}
`;
const esc = (t) => String(t ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const H = { 'Content-Type': 'application/json', 'X-Requested-With': 'sentry-six-manager' };
const MIN_R = 50;
const MAX_R = 2000;
const DEF_R = 200;
const PLACE_COLOR = '#ffd34a';
const DRAFT_COLOR = '#3ddc84';

/**
 * Coordinates typed or pasted as maps apps copy them, as { lat, lon }, or
 * null: "41.8781, -87.6298", "41.8781° N, 87.6298° W", "N 41.8781 W 87.6298",
 * 41°52'41.2"N 87°37'47.3"W, and links with @lat,lon, q=lat,lon or ll=lat,lon.
 */
export function parseCoords(text) {
  let s = String(text ?? '').trim();
  if (!s || s.length > 2000) return null;
  const inLink = s.match(/[@=](-?\d{1,3}(?:\.\d+)?),\s*(-?\d{1,3}(?:\.\d+)?)/);
  if (/^[a-z]+:\/\//i.test(s) || /[?&](q|ll|query|sll|daddr)=/.test(s)) return inLink ? check(Number(inLink[1]), Number(inLink[2])) : null;
  s = s.replace(/[′’‘`´]/g, "'").replace(/[″“”]/g, '"').replace(/''/g, '"').replace(/º|˚/g, '°').replace(/\s+/g, ' ').toUpperCase();
  // "41,8781; -87,6298": decimal commas when a semicolon parts the two
  if (s.includes(';')) s = s.replace(/(\d),(\d)/g, '$1.$2').replace(';', ',');
  const num = String.raw`(-|\+)?\s*(\d{1,3}(?:\.\d+)?)\s*(?:°\s*(?:(\d{1,2}(?:\.\d+)?)\s*'\s*(?:(\d{1,2}(?:\.\d+)?)\s*")?)?)?`;
  const lead = /^[NSEW]/.test(s);
  const re = new RegExp(lead ? String.raw`([NSEW])\s*${num}` : String.raw`${num}\s*([NSEW])?`, 'g');
  const parts = [];
  let rest = s;
  for (const m of s.matchAll(re)) {
    const [hemi, sign, d, mi, se] = lead ? [m[1], m[2], m[3], m[4], m[5]] : [m[5], m[1], m[2], m[3], m[4]];
    if (mi !== undefined && !/^\d+$/.test(d)) return null; // 41.5°30' is not a coordinate
    if (Number(mi ?? 0) >= 60 || Number(se ?? 0) >= 60) return null;
    let v = Number(d) + Number(mi ?? 0) / 60 + Number(se ?? 0) / 3600;
    if (sign === '-') v = -v;
    if (hemi === 'S' || hemi === 'W') {
      if (sign === '-') return null; // "-41 S" says it twice
      v = -v;
    }
    parts.push({ v, axis: hemi === 'N' || hemi === 'S' ? 'lat' : hemi === 'E' || hemi === 'W' ? 'lon' : null });
    rest = rest.replace(m[0], ' ');
  }
  // nothing else may be in there but the separator
  if (parts.length !== 2 || /[^\s,/]/.test(rest)) return null;
  const [a, b] = parts;
  if (a.axis && b.axis) {
    if (a.axis === b.axis) return null;
    return a.axis === 'lat' ? check(a.v, b.v) : check(b.v, a.v);
  }
  if (a.axis === 'lon' || b.axis === 'lat') return null;
  return check(a.v, b.v);
}
function check(lat, lon) {
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  if (lat === 0 && lon === 0) return null;
  return { lat: Math.round(lat * 1e6) / 1e6, lon: Math.round(lon * 1e6) / 1e6 };
}

/** Coordinates as the "Add a place yourself" field shows them: 6 decimals. */
export function coordsText(lat, lon) {
  return `${Number(lat).toFixed(6)}, ${Number(lon).toFixed(6)}`;
}

/** A circle of `radius` metres around a spot, as a closed ring of [lat, lon]. */
export function circleRing(lat, lon, radius, steps = 64) {
  const dLat = radius / 111195;
  const dLon = radius / (111195 * Math.max(0.01, Math.cos((lat * Math.PI) / 180)));
  const ring = [];
  for (let i = 0; i <= steps; i++) {
    const t = (i % steps) / steps * 2 * Math.PI;
    ring.push([lat + dLat * Math.cos(t), lon + dLon * Math.sin(t)]);
  }
  return ring;
}

const radiusOf = (p) => (Number.isFinite(p?.radius) && p.radius >= MIN_R && p.radius <= MAX_R ? p.radius : DEF_R);

/**
 * What the map shows: the saved places (labelled, their radius drawn; one
 * being dragged where it was dropped), the suggestions (their count) and the
 * dropped pin (with the radius typed in the form). Only admins drag.
 * @returns {{ marks: object[], shapes: object[], points: number[][] }}
 */
export function mapMarks({ places = [], suggestions = [], draft = null, radius = DEF_R, canEdit = false, moving = null } = {}) {
  const marks = [];
  const shapes = [];
  const points = [];
  for (const p of places) {
    const at = moving?.id === p.id ? moving : p;
    if (!Number.isFinite(at.lat) || !Number.isFinite(at.lon)) continue;
    const r = radiusOf(p);
    marks.push({ id: p.id, kind: 'place', lat: at.lat, lon: at.lon, label: p.name, title: `${p.name} · ${r} m${canEdit ? ' · drag to move it' : ''}`, draggable: canEdit });
    const ring = circleRing(at.lat, at.lon, r);
    shapes.push({ id: `place-${p.id}`, color: PLACE_COLOR, coords: ring });
    points.push(...ring);
  }
  suggestions.forEach((x, i) => {
    if (!Number.isFinite(x.lat) || !Number.isFinite(x.lon)) return;
    marks.push({ id: `sugg-${i}`, i, kind: 'sugg', lat: x.lat, lon: x.lon, label: String(x.count ?? ''), title: `${plural(x.count, 'event')} here${x.street ? ` · ${x.street}` : ''}` });
    points.push([x.lat, x.lon]);
  });
  if (draft && Number.isFinite(draft.lat) && Number.isFinite(draft.lon)) {
    const r = Number.isFinite(radius) && radius >= MIN_R && radius <= MAX_R ? radius : DEF_R;
    marks.push({ id: 'draft', kind: 'draft', lat: draft.lat, lon: draft.lon, title: `The pin you dropped · ${r} m${canEdit ? ' · drag to move it' : ''}`, draggable: canEdit });
    shapes.push({ id: 'draft', color: DRAFT_COLOR, coords: circleRing(draft.lat, draft.lon, r) });
  }
  return { marks, shapes, points };
}

/**
 * "Set as Home" / "Set as Work" at a spot: moves the place of that name if
 * there is one (PATCH, keeping its radius unless one is given), else saves a
 * new one (POST, with the radius or the default).
 */
export function setAsRequest(places, name, at, radius) {
  const same = (places || []).find((p) => String(p.name).trim().toLowerCase() === name.trim().toLowerCase());
  const pos = { lat: Math.round(at.lat * 1e6) / 1e6, lon: Math.round(at.lon * 1e6) / 1e6 };
  if (same) return { method: 'PATCH', url: `/api/places/${encodeURIComponent(same.id)}`, body: { ...pos, ...(radius !== undefined ? { radius } : {}) }, moves: same };
  return { method: 'POST', url: '/api/places', body: { name, ...pos, radius: radius ?? DEF_R }, moves: null };
}

// light or dark, from the first background behind the element that is not see-through
function looksDark(node) {
  for (let n = node; n && n.nodeType === 1; n = n.parentElement) {
    const m = getComputedStyle(n).backgroundColor.match(/[\d.]+/g);
    if (!m || (m.length > 3 && Number(m[3]) < 0.5)) continue;
    const [r, g, b] = m.map(Number);
    return 0.2126 * r + 0.7152 * g + 0.0722 * b < 128;
  }
  return typeof matchMedia === 'function' ? matchMedia('(prefers-color-scheme: dark)').matches : true;
}

// a form's field (form.name is the form's own name, not its Name field)
const fld = (form, name) => form.querySelector(`[name="${name}"]`);
const fix6 = (n) => (Number.isFinite(n) ? n.toFixed(6) : '?');
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
function dayText(at) {
  if (!at) return '';
  const d = new Date(String(at).replace(' ', 'T'));
  if (Number.isNaN(d.getTime())) return String(at).slice(0, 10);
  return d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', year: d.getFullYear() === new Date().getFullYear() ? undefined : 'numeric' });
}

export function createPlacesSettings(el, { cls = {}, toast = () => {}, confirm = async () => window.confirm('Remove this place?'), dark } = {}) {
  if (!document.getElementById('sentry-pl-css')) {
    const style = document.createElement('style');
    style.id = 'sentry-pl-css';
    style.textContent = STYLE;
    document.head.appendChild(style);
  }
  const c = { btn: 'btn', primary: 'btn primary', danger: 'btn danger', input: 'input', muted: 'muted', ...cls };
  const secure = typeof window !== 'undefined' && window.isSecureContext && 'geolocation' in navigator;
  el.innerHTML = `<div class="sentry-pl">
    <p>Sentry and Saved events within a place’s radius get a tag like <span class="pl-tag">at Home</span> on the Footage page. Recent clips have no position from Tesla.</p>
    <div class="pl-cols"><div class="pl-col">
    <section><h3>Saved places</h3><ul data-places><li class="pl-dim">Loading…</li></ul></section>
    <section><h3>Where the car parks most</h3>
      <p class="${c.muted} pl-note">From where the car was in its Sentry and Saved events of the last 90 days. Spots a saved place covers already are left out.</p>
      <ul data-sugg><li class="pl-dim">Looking through the events…</li></ul></section>
    </div><div class="pl-col">
    <section data-mapsec><h3>On the map</h3>
      <div class="pl-bar" data-mapbar aria-live="polite"></div>
      <div class="pl-map" data-map></div></section>
    <section data-addsec><h3>Add a place yourself</h3>
      <form class="pl-add" data-add novalidate>
        <label class="pl-f">Name<input class="${c.input}" name="name" maxlength="60" placeholder="Home" autocomplete="off" required></label>
        <label class="pl-f" style="flex-basis:260px">Coordinates<input class="${c.input} pl-mono" name="coords" placeholder="41.8781, -87.6298" autocomplete="off" autocapitalize="none" spellcheck="false" inputmode="text"></label>
        <label class="pl-f pl-r">Radius (m)<input class="${c.input}" name="radius" type="number" min="${MIN_R}" max="${MAX_R}" step="10" value="200" inputmode="numeric"></label>
        <div class="pl-acts"><button class="${c.btn}" type="button" data-here${secure ? '' : ' disabled'}>Use this device’s location</button><button class="${c.primary}" type="submit">Save place</button></div>
        <p class="${c.muted} pl-note" style="width:100%">Paste coordinates as a maps app copies them, like <span class="pl-mono">41.8781, -87.6298</span> or <span class="pl-mono">41.8781° N, 87.6298° W</span>. ${secure ? 'Or stand at the place and use this device’s location.' : 'This device’s location needs the manager opened over HTTPS (the browser keeps it from plain HTTP pages), or a browser that shares it.'}</p>
        <p class="pl-note pl-err" data-adderr role="alert" hidden></p>
      </form></section>
    </div></div>
  </div>`;
  const $ = (s) => el.querySelector(s);
  let alive = true;
  let places = [];
  let counts = null;
  let sugg = null;
  let suggErr = '';
  // the map: no pins to drop or drag until the account is known to be an admin's
  let canEdit = false;
  let draft = null; // the pin dropped on the map: { lat, lon }
  let moving = null; // a saved place dragged, waiting for Save: { id, name, lat, lon }
  let radiusTouched = false; // the radius was typed: "Set as Home" moving Home takes it too
  let map = null;
  let fitted = false;
  // places are for admins: a watch-only account sees them, without the buttons
  fetch('/api/auth/me', { credentials: 'same-origin' }).then((r) => (r.ok ? r.json() : null)).then((m) => {
    if (!alive) return;
    if (m?.role !== 'viewer') { canEdit = true; drawMap(); return; }
    const root = el.querySelector('.sentry-pl');
    root?.classList.add('pl-ro');
    root?.insertAdjacentHTML('afterbegin', `<p class="${c.muted} pl-note">Only an admin can add or change places.</p>`);
    drawMap();
  }).catch(() => {});

  const radiusOk = (v) => Number.isFinite(v) && v >= MIN_R && v <= MAX_R;
  async function call(method, url, body) {
    const r = await fetch(url, { method, credentials: 'same-origin', headers: H, body: body === undefined ? undefined : JSON.stringify(body) });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error || `The server said ${r.status}.`);
    return data;
  }
  const hasName = (n) => places.some((p) => p.name.trim().toLowerCase() === n.toLowerCase());

  // ---- the map ----
  const mapEl = $('[data-map]');
  const addForm = $('[data-add]');
  const formRadius = () => {
    const v = Number(fld(addForm, 'radius').value);
    return radiusOk(v) ? Math.round(v) : DEF_R;
  };
  const isDark = () => (typeof dark === 'boolean' ? dark : looksDark(el));
  const theme = () => {
    const d = isDark();
    mapEl.classList.toggle('pl-light', !d);
    map?.setDark(d);
  };
  const watchTheme = typeof MutationObserver === 'function' ? new MutationObserver(() => theme()) : null;
  watchTheme?.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'data-theme', 'style'] });
  if (document.body) watchTheme?.observe(document.body, { attributes: true, attributeFilter: ['class', 'data-theme'] });
  const schemeMq = typeof matchMedia === 'function' ? matchMedia('(prefers-color-scheme: dark)') : null;
  schemeMq?.addEventListener?.('change', theme);
  mapEl.classList.toggle('pl-light', !isDark());
  import('/web/viewerMap.js').then(({ createViewerMap }) => {
    if (!alive) return;
    map = createViewerMap(mapEl, { dark: isDark(), always: true, places: false, heading: false, onClick: dropPin });
    drawMap();
    placeCamera();
  }).catch(() => { mapEl.textContent = 'The map could not be loaded.'; });

  function dropPin(lat, lon) {
    if (!canEdit || moving) return;
    const at = check(lat, lon);
    if (!at) return;
    draft = at;
    fld(addForm, 'coords').value = coordsText(at.lat, at.lon);
    $('[data-adderr]').hidden = true;
    drawMap();
  }
  function drawMap({ shapesOnly = false } = {}) {
    drawBar();
    if (!map) return;
    const { marks, shapes } = mapMarks({ places, suggestions: sugg?.suggestions || [], draft, radius: formRadius(), canEdit, moving });
    map.setShapes(shapes);
    if (shapesOnly) return;
    map.setMarks(marks, {
      onPick: (k) => {
        if (k.kind === 'place') { const li = el.querySelector(`[data-place="${CSS.escape(k.id)}"]`); li?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); }
        else if (k.kind === 'sugg') el.querySelector(`[data-sugg-i="${k.i}"]`)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      },
      onDrag: (k, lat, lon) => {
        const at = check(lat, lon);
        if (!at || !canEdit) { drawMap(); return; }
        if (k.kind === 'draft') { draft = at; fld(addForm, 'coords').value = coordsText(at.lat, at.lon); drawMap(); return; }
        const p = places.find((x) => x.id === k.id);
        if (!p) return;
        moving = { id: p.id, name: p.name, ...at };
        drawMap();
      }
    });
  }
  function drawBar() {
    const bar = $('[data-mapbar]');
    if (!canEdit) { bar.innerHTML = `<span class="${c.muted} pl-note pl-grow">Saved places with their radius, and where the car parks most.</span>`; return; }
    if (moving) {
      bar.innerHTML = `<span class="pl-grow">Move <b>${esc(moving.name)}</b> to <span class="pl-mono">${coordsText(moving.lat, moving.lon)}</span>?</span>
        <span class="pl-acts"><button class="${c.btn}" type="button" data-movecancel>Cancel</button><button class="${c.primary}" type="button" data-movesave>Save</button></span>`;
      return;
    }
    if (draft) {
      const home = hasName('Home');
      const work = hasName('Work');
      bar.innerHTML = `<span class="pl-grow pl-mono">${coordsText(draft.lat, draft.lon)}</span>
        <span class="pl-acts"><button class="${c.primary}" type="button" data-setas="Home" title="${home ? 'Move Home here' : 'Save this spot as Home'}">Set as Home</button><button class="${c.btn}" type="button" data-setas="Work" title="${work ? 'Move Work here' : 'Save this spot as Work'}">Set as Work</button><button class="${c.btn}" type="button" data-pinname>Save as…</button><button class="${c.btn}" type="button" data-pinclear>Clear</button></span>`;
      return;
    }
    bar.innerHTML = `<span class="${c.muted} pl-note pl-grow">Click the map where a place is to drop a pin, then set it as Home or Work. Drag a saved place to move it.</span>`;
  }
  // the camera, once: around the places and suggestions, else the newest event with a position, else the world
  async function placeCamera() {
    if (fitted || !map || !sugg && !suggErr) return;
    fitted = true;
    const { points } = mapMarks({ places, suggestions: sugg?.suggestions || [] });
    if (points.length) { map.fit(points, { maxZoom: 16 }); return; }
    let spot = null;
    try {
      const v = (await call('GET', '/api/vehicles')).vehicles?.[0];
      const ev = v ? (await call('GET', `/api/vehicles/${encodeURIComponent(v.id)}/event-map`)).events?.[0] : null;
      if (ev && Number.isFinite(ev.lat) && Number.isFinite(ev.lon)) spot = [ev.lat, ev.lon];
    } catch { /* the world, then */ }
    if (!alive || !map) return;
    if (spot) map.centre(spot, 15);
    else map.centre([30, 0], 2);
  }
  function clearDraft() {
    draft = null;
    radiusTouched = false;
    drawMap();
  }
  async function setAs(name, b) {
    if (!draft) return;
    const r = Number(fld(addForm, 'radius').value);
    if (radiusTouched && !radiusOk(r)) return toast(`The radius is ${MIN_R} to ${MAX_R} m.`, true);
    const req = setAsRequest(places, name, draft, radiusTouched ? Math.round(r) : (hasName(name) ? undefined : formRadius()));
    b.disabled = true;
    try {
      await call(req.method, req.url, req.body);
      toast(req.moves ? `Moved ${req.moves.name} here.` : `Saved ${name}. Events there get the tag “at ${name}”.`, false);
      addForm.reset();
      clearDraft();
      await reload();
    } catch (err) { toast(err.message, true); } finally { if (document.contains(b)) b.disabled = false; }
  }

  function drawPlaces() {
    $('[data-places]').innerHTML = places.map((p) => {
      const r = Number.isFinite(p.radius) ? p.radius : 200;
      const n = counts?.[p.id];
      return `<li data-place="${esc(p.id)}"><i class="pl-pin" aria-hidden="true"></i>
        <span class="pl-grow"><b>${esc(p.name)}</b>${Number.isFinite(n) ? ` <span class="pl-tag">${esc(plural(n, 'event'))}</span>` : ''}<br><span class="pl-mono pl-dim">${fix6(p.lat)}, ${fix6(p.lon)} · ${r} m</span></span>
        <span class="pl-acts"><button class="${c.btn}" type="button" data-edit>Edit</button><button class="${c.danger}" type="button" data-del>Delete</button></span>
        <form class="pl-edit" data-editform hidden novalidate>
          <label class="pl-f">Name<input class="${c.input}" name="name" maxlength="60" value="${esc(p.name)}" required></label>
          <label class="pl-f pl-r">Radius (m)<input class="${c.input}" name="radius" type="number" min="${MIN_R}" max="${MAX_R}" step="10" value="${r}" inputmode="numeric"></label>
          <span class="pl-acts"><button class="${c.btn}" type="button" data-cancel>Cancel</button><button class="${c.primary}" type="submit">Save</button></span>
        </form></li>`;
    }).join('') || `<li class="pl-dim">No saved places yet. Save one from the suggestions below, or add one yourself.</li>`;
  }
  function drawSugg() {
    const box = $('[data-sugg]');
    if (suggErr) { box.innerHTML = `<li class="pl-err">${esc(suggErr)}</li>`; return; }
    if (!sugg) return;
    const list = sugg.suggestions || [];
    box.innerHTML = list.map((s, i) => {
      const where = [s.street, s.city].filter(Boolean).join(', ') || 'A spot without a street name';
      const btns = [!hasName('Home') && `<button class="${c.btn}" type="button" data-save="Home">Save as Home</button>`, !hasName('Work') && `<button class="${c.btn}" type="button" data-save="Work">Save as Work</button>`, `<button class="${c.btn}" type="button" data-saveas>Save as…</button>`].filter(Boolean).join('');
      return `<li data-sugg-i="${i}"><span class="pl-grow"><b>${esc(where)}</b><br><span class="pl-dim">${esc(plural(s.count, 'event'))}${s.last ? ` · last ${esc(dayText(s.last))}` : ''}${s.vehicles?.length > 1 ? ` · ${esc(s.vehicles.join(', '))}` : ''}</span><br><span class="pl-mono pl-dim">${fix6(s.lat)}, ${fix6(s.lon)}</span></span>
        <span class="pl-acts">${btns}</span>
        <form class="pl-edit" data-nameform hidden novalidate><label class="pl-f">Name<input class="${c.input}" name="name" maxlength="60" placeholder="Gym, Mum’s" required></label>
          <span class="pl-acts"><button class="${c.btn}" type="button" data-cancel>Cancel</button><button class="${c.primary}" type="submit">Save</button></span></form></li>`;
    }).join('') || `<li class="pl-dim">${sugg.withPosition ? 'Nowhere yet: no spot has two or more events outside the saved places.' : sugg.events ? 'None of the recent events has a position (event.json est_lat / est_lon).' : 'No Sentry or Saved events in the last 90 days.'}</li>`;
  }
  async function loadPlaces() {
    try { places = (await call('GET', '/api/places')).places || []; } catch (err) { if (alive) $('[data-places]').innerHTML = `<li class="pl-err">${esc(err.message)}</li>`; return; }
    if (alive) { drawPlaces(); drawMap(); }
  }
  async function loadSugg() {
    try {
      sugg = await call('GET', '/api/places/suggestions');
      counts = sugg.counts || null;
      suggErr = '';
    } catch (err) { suggErr = err.message; }
    if (!alive) return;
    drawSugg();
    drawPlaces();
    drawMap();
    placeCamera();
  }
  const reload = async () => { await loadPlaces(); if (alive) await loadSugg(); };

  async function add(name, lat, lon, radius) {
    await call('POST', '/api/places', { name, lat, lon, ...(radius !== undefined ? { radius } : {}) });
    toast(`Saved ${name}. Events there get the tag “at ${name}”.`, false);
    await reload();
  }

  el.addEventListener('click', async (e) => {
    const b = e.target.closest('button');
    if (!b && !e.target.closest('form, input, a, [data-map]')) {
      // a saved place or a suggestion: the map goes to it
      const row = e.target.closest('li[data-place], li[data-sugg-i]');
      const at = row?.dataset.place ? places.find((x) => x.id === row.dataset.place) : row ? sugg?.suggestions?.[Number(row.dataset.suggI)] : null;
      if (at && map) map.centre([at.lat, at.lon], 17);
      return;
    }
    if (!b || !el.contains(b) || b.closest('[data-map]')) return;
    const li = b.closest('li');
    if (b.dataset.setas) {
      await setAs(b.dataset.setas, b);
    } else if (b.hasAttribute('data-pinname')) {
      const n = fld(addForm, 'name');
      n.scrollIntoView({ block: 'center', behavior: 'smooth' });
      n.focus({ preventScroll: true });
    } else if (b.hasAttribute('data-pinclear')) {
      fld(addForm, 'coords').value = '';
      clearDraft();
    } else if (b.hasAttribute('data-movecancel')) {
      moving = null;
      drawMap();
    } else if (b.hasAttribute('data-movesave')) {
      if (!moving) return;
      const m = moving;
      b.disabled = true;
      try {
        await call('PATCH', `/api/places/${encodeURIComponent(m.id)}`, { lat: m.lat, lon: m.lon });
        toast(`Moved ${m.name}.`, false);
        moving = null;
        await reload();
      } catch (err) { b.disabled = false; toast(err.message, true); }
    } else if (b.hasAttribute('data-edit')) {
      const f = li.querySelector('[data-editform]');
      f.hidden = !f.hidden;
      if (!f.hidden) f.querySelector('input').focus();
    } else if (b.hasAttribute('data-cancel')) {
      b.closest('form').hidden = true;
    } else if (b.hasAttribute('data-del')) {
      const p = places.find((x) => x.id === li.dataset.place);
      if (!p || !(await confirm({ title: `Delete ${p.name}?`, body: `<p>Events there lose the tag “at ${esc(p.name)}”. No footage is deleted.</p>`, ok: 'Delete place' }))) return;
      try { await call('DELETE', `/api/places/${encodeURIComponent(p.id)}`); toast(`Deleted ${p.name}.`, false); await reload(); } catch (err) { toast(err.message, true); }
    } else if (b.dataset.save) {
      const s = sugg?.suggestions?.[Number(li.dataset.suggI)];
      if (!s) return;
      b.disabled = true;
      try { await add(b.dataset.save, s.lat, s.lon); } catch (err) { b.disabled = false; toast(err.message, true); }
    } else if (b.hasAttribute('data-saveas')) {
      const f = li.querySelector('[data-nameform]');
      f.hidden = !f.hidden;
      if (!f.hidden) f.querySelector('input').focus();
    } else if (b.hasAttribute('data-here')) {
      const form = $('[data-add]');
      b.disabled = true;
      const was = b.textContent;
      b.textContent = 'Finding this device…';
      navigator.geolocation.getCurrentPosition((pos) => {
        b.disabled = false;
        b.textContent = was;
        fld(form, 'coords').value = coordsText(pos.coords.latitude, pos.coords.longitude);
        draft = parseCoords(fld(form, 'coords').value);
        drawMap();
        if (draft) map?.centre([draft.lat, draft.lon], 17);
        const acc = Math.round(pos.coords.accuracy || 0);
        toast(`Found this device${acc ? ` (to within ${acc} m)` : ''}. Name the place and save it.`, false);
        (fld(form, 'name').value ? form.querySelector('[type=submit]') : fld(form, 'name')).focus();
      }, (err) => {
        b.disabled = false;
        b.textContent = was;
        toast(err.code === 1 ? 'The browser was not allowed to share this device’s location.' : 'This device’s location is not available right now.', true);
      }, { enableHighAccuracy: true, timeout: 20000, maximumAge: 60000 });
    }
  });
  el.addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target;
    const go = f.querySelector('[type=submit]');
    try {
      if (f.matches('[data-add]')) {
        const err = $('[data-adderr]');
        const fail = (m) => { err.textContent = m; err.hidden = false; };
        err.hidden = true;
        const name = fld(f, 'name').value.trim();
        const at = parseCoords(fld(f, 'coords').value);
        const radius = Number(fld(f, 'radius').value);
        if (!name) return fail('Give the place a name, like Home or Work.');
        if (!at) return fail(fld(f, 'coords').value.trim() ? 'Those are not coordinates the manager can read. Try 41.8781, -87.6298.' : 'Paste the coordinates, or use this device’s location.');
        if (!radiusOk(radius)) return fail(`The radius is ${MIN_R} to ${MAX_R} m.`);
        go.disabled = true;
        await add(name, at.lat, at.lon, Math.round(radius));
        f.reset();
        clearDraft();
      } else if (f.matches('[data-editform]')) {
        const id = f.closest('li').dataset.place;
        const radius = Number(fld(f, 'radius').value);
        if (!fld(f, 'name').value.trim()) return toast('Give the place a name.', true);
        if (!radiusOk(radius)) return toast(`The radius is ${MIN_R} to ${MAX_R} m.`, true);
        go.disabled = true;
        await call('PATCH', `/api/places/${encodeURIComponent(id)}`, { name: fld(f, 'name').value, radius: Math.round(radius) });
        toast('Saved.', false);
        await reload();
      } else if (f.matches('[data-nameform]')) {
        const s = sugg?.suggestions?.[Number(f.closest('li').dataset.suggI)];
        const name = fld(f, 'name').value.trim();
        if (!s) return;
        if (!name) return toast('Give the place a name.', true);
        go.disabled = true;
        await add(name, s.lat, s.lon);
      }
    } catch (err) {
      toast(err.message, true);
    } finally {
      if (go && document.contains(go)) go.disabled = false;
    }
  });
  // typing in the form moves the dropped pin and its circle
  addForm.addEventListener('input', (e) => {
    if (e.target.name === 'radius') { radiusTouched = true; drawMap({ shapesOnly: true }); }
    else if (e.target.name === 'coords' && canEdit) {
      const at = parseCoords(e.target.value);
      if (at || !e.target.value.trim()) { draft = at; drawMap(); }
    }
  });
  reload();
  return {
    destroy() {
      alive = false;
      watchTheme?.disconnect();
      schemeMq?.removeEventListener?.('change', theme);
      map?.destroy();
      el.innerHTML = '';
    },
    reload
  };
}
