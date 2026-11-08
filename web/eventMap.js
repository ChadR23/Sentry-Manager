// The Map page, the same in every interface: every Sentry and Saved event of
// a vehicle as a pin where it happened (from Tesla's event.json), the newest
// events listed under it, and the saved places (named in Settings > Places or on the
// Viewer's map with "Save place"), which can be renamed or removed here.
//
//   const page = createEventMapPage(el, {
//     vehicleId, vehicleName,
//     openEvent: (ev) => …   // { recording, day, startKey, … }: open it in the Viewer
//   });

import { createViewerMap } from '/web/viewerMap.js';

const STYLE = `
.sentry-em{display:flex;flex-direction:column;gap:14px;font-size:14px;line-height:1.45}
.sentry-em .em-map{height:min(62vh,560px);min-height:300px;border-radius:12px;overflow:hidden}
.sentry-em .em-row{display:flex;flex-wrap:wrap;gap:6px 16px;align-items:center}
.sentry-em .em-muted{opacity:.7}
.sentry-em .em-key{display:inline-flex;align-items:center;gap:6px}
.sentry-em .em-key i{width:12px;height:12px;border-radius:50%;border:2px solid #fff;box-shadow:0 0 0 1px rgba(0,0,0,.3)}
.sentry-em h2{margin:4px 0 0;font-size:16px}
.sentry-em ol{list-style:none;margin:0;padding:0;display:flex;flex-direction:column}
.sentry-em li{display:flex;gap:10px;align-items:center;padding:7px 0;border-top:1px solid rgba(127,127,127,.2)}
.sentry-em li i{width:10px;height:10px;border-radius:50%;flex:none}
.sentry-em li .em-grow{flex:1;min-width:0}
.sentry-em button.em-btn{all:unset;box-sizing:border-box;cursor:pointer;padding:5px 10px;border-radius:7px;border:1px solid rgba(127,127,127,.45);font-weight:600;font-size:13px;white-space:nowrap}
.sentry-em button.em-btn:focus-visible{outline:2px solid currentColor;outline-offset:2px}
.sentry-em .em-tag{font-size:11px;font-weight:700;padding:1px 7px;border-radius:999px;background:rgba(255,211,74,.22);white-space:nowrap}
.sentry-em button.em-btn[aria-pressed="true"]{background:rgba(127,127,127,.25)}
.sentry-em input{padding:5px 8px;border-radius:7px;border:1px solid rgba(127,127,127,.45);background:transparent;color:inherit;font:inherit;min-width:0}
`;
const COLOR = { Sentry: '#ff5d5d', Saved: '#3ddc84' };
const esc = (t) => String(t ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const REASON = {
  sentry_aware_object_detection: 'Something moved near the car', sentry_aware_accel: 'The car was bumped or moved',
  sentry_locked_handle_pulls: 'A door handle was pulled', user_interaction_dashcam_icon_tapped: 'Saved from the screen',
  user_interaction_honk: 'Saved with the horn', user_interaction_dashcam_launcher_action_tapped: 'Saved from the screen'
};
const reasonText = (r) => (r ? REASON[r] || String(r).replace(/_/g, ' ') : '');
const H = { 'Content-Type': 'application/json', 'X-Requested-With': 'sentry-six-manager' };

export function createEventMapPage(el, { vehicleId, vehicleName = '', openEvent = () => {}, dark = true } = {}) {
  if (!document.getElementById('sentry-em-css')) {
    const style = document.createElement('style');
    style.id = 'sentry-em-css';
    style.textContent = STYLE;
    document.head.appendChild(style);
  }
  el.innerHTML = `<div class="sentry-em">
    <div class="em-row"><span class="em-muted" data-sum>Loading the events…</span>
      <span class="em-key"><i style="background:${COLOR.Sentry}"></i>Sentry</span><span class="em-key"><i style="background:${COLOR.Saved}"></i>Saved</span></div>
    <div class="em-row" data-placefilter hidden></div>
    <div class="em-map" data-map></div>
    <h2>Newest events</h2><ol data-list></ol>
    <h2>Saved places</h2><p class="em-muted" style="margin:0">Add places (Home, Work) in Settings &gt; Places, with suggestions from where the car parks most, or from the Viewer's map: the pin button, tap the place, then <b>Save place</b>. Saved places show on the maps, and the place search can go straight to them.</p><ol data-places></ol>
  </div>`;
  const $ = (s) => el.querySelector(s);
  let alive = true;
  let events = [];
  let allEvents = [];
  let shownPlace = null; // filter: a saved place's name, '-' (elsewhere) or null (all)
  // the saved places events happened at, as a filter
  function drawFilter() {
    const names = [...new Set(allEvents.map((ev) => ev.place).filter(Boolean))].sort();
    const box = $('[data-placefilter]');
    box.hidden = !names.length;
    const btn = (v, label) => `<button type="button" class="em-btn" data-place-f="${esc(v ?? '')}" aria-pressed="${shownPlace === v}">${esc(label)}</button>`;
    box.innerHTML = `<span class="em-muted">Where:</span>${btn(null, 'Anywhere')}${names.map((n) => btn(n, `At ${n}`)).join('')}${btn('-', 'Elsewhere')}`;
  }
  const map = createViewerMap($('[data-map]'), { dark, noGps: 'No events with a position yet' });

  const when = (ev) => { try { return new Date(`${ev.startKey.slice(0, 10)}T${ev.startKey.slice(11).replace(/-/g, ':')}`).toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }); } catch { return ev.start || ev.day; } };
  let withoutPosition = 0;
  let loads = 0;
  async function loadEvents() {
    if (!vehicleId) { $('[data-sum]').textContent = 'Add a vehicle first.'; return; }
    const mine = ++loads; // a newer load wins
    try {
      const r = await fetch(`/api/vehicles/${encodeURIComponent(vehicleId)}/event-map`, { credentials: 'same-origin' });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || 'Could not load the events.');
      if (!alive || mine !== loads) return;
      allEvents = d.events;
      withoutPosition = d.withoutPosition;
      if (shownPlace && shownPlace !== '-' && !allEvents.some((ev) => ev.place === shownPlace)) shownPlace = null;
      drawEvents();
    } catch (err) {
      if (alive && mine === loads) $('[data-sum]').textContent = err.message;
    }
  }
  // the filter only redraws: the events are already here
  function drawEvents() {
    events = shownPlace ? allEvents.filter((ev) => (ev.place || '') === (shownPlace === '-' ? '' : shownPlace)) : allEvents;
    drawFilter();
    $('[data-sum]').textContent = `${vehicleName ? `${vehicleName}: ` : ''}${events.length} event${events.length === 1 ? '' : 's'} with a position${withoutPosition ? ` (${withoutPosition} without one)` : ''}`;
    map.setPins(events.map((ev, i) => ({ lat: ev.lat, lon: ev.lon, color: COLOR[ev.category] || '#6aa9ff', title: `${ev.category} · ${when(ev)}${ev.place ? ` · at ${ev.place}` : ''}${ev.reason ? ` · ${reasonText(ev.reason)}` : ''}`, i })), { onPick: (p) => openEvent(events[p.i]) });
    $('[data-list]').innerHTML = events.slice(0, 50).map((ev, i) => `<li><i style="background:${COLOR[ev.category] || '#6aa9ff'}"></i>
        <span class="em-grow"><b>${esc(when(ev))}</b> · ${esc(ev.category)}${ev.place ? ` <span class="em-tag">at ${esc(ev.place)}</span>` : ''}${ev.reason ? ` · ${esc(reasonText(ev.reason))}` : ''}<br><span class="em-muted">${esc([ev.street, ev.city].filter(Boolean).join(', '))}</span></span>
        <button type="button" class="em-btn" data-open="${i}">Play</button></li>`).join('') || '<li class="em-muted">No Sentry or Saved events with a position.</li>';
  }
  async function loadPlaces() {
    let places = [];
    try { const r = await fetch('/api/places', { credentials: 'same-origin' }); places = r.ok ? (await r.json()).places : []; } catch { /* none */ }
    if (!alive) return;
    $('[data-places]').innerHTML = places.map((p) => `<li><i style="background:#ffd34a;border-radius:3px"></i>
      <span class="em-grow"><input value="${esc(p.name)}" maxlength="60" aria-label="Name of this place" data-name="${esc(p.id)}"> <span class="em-muted">${p.lat.toFixed(4)}, ${p.lon.toFixed(4)}</span></span>
      <button type="button" class="em-btn" data-rename="${esc(p.id)}">Rename</button><button type="button" class="em-btn" data-remove="${esc(p.id)}">Remove</button></li>`).join('') || '<li class="em-muted">None yet.</li>';
  }
  el.addEventListener('click', async (e) => {
    const f = e.target.closest('[data-place-f]');
    if (f) { shownPlace = f.dataset.placeF === '' ? null : f.dataset.placeF; drawEvents(); return; }
    const o = e.target.closest('[data-open]');
    if (o) { openEvent(events[Number(o.dataset.open)]); return; }
    const rn = e.target.closest('[data-rename]');
    if (rn) {
      const input = el.querySelector(`[data-name="${CSS.escape(rn.dataset.rename)}"]`);
      await fetch(`/api/places/${encodeURIComponent(rn.dataset.rename)}`, { method: 'PATCH', credentials: 'same-origin', headers: H, body: JSON.stringify({ name: input.value }) });
      loadPlaces();
      loadEvents(); // the events' place names
      return;
    }
    const rm = e.target.closest('[data-remove]');
    if (rm) {
      await fetch(`/api/places/${encodeURIComponent(rm.dataset.remove)}`, { method: 'DELETE', credentials: 'same-origin', headers: H });
      loadPlaces();
      loadEvents();
    }
  });
  loadEvents();
  loadPlaces();
  return { destroy() { alive = false; map.destroy(); el.innerHTML = ''; } };
}
