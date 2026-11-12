// Drives, the same in every interface (Sentry Studio's Drives tab, for the
// footage on the server): a vehicle's trips (GET /api/vehicles/:id/drives),
// newest first and grouped by day, each with its times, length, distance and
// where it started and ended; picking one plays it from its start in the
// interface's own Viewer. Where the car's share has Sentry USB's drive data
// (drive-data.json), the drives are Sentry USB's, with their Autopilot / FSD
// share, drive tags and the shape of the route; else they are grouped from
// the clips. The page says which. Plain markup (sentry-drives-*), colours inherited
// from the page; a pack can style it.
//
//   const page = createDrivesPage(el, {
//     vehicleId, vehicleName,
//     open: (at, drive) => …,  // at: { recording, day, clip, second }: play it there
//     h24: () => false          // the interface's 24-hour clock setting
//   });
import { footMinutes } from '/web/duration.js';
import '/web/units.js';

const CSS = `
.sentry-drives{display:flex;flex-direction:column;gap:14px;font-size:14px;line-height:1.45;min-width:0}
.sentry-drives .sv-row{display:flex;flex-wrap:wrap;gap:8px 16px;align-items:center}
.sentry-drives .sv-grow{flex:1 1 auto;min-width:0}
.sentry-drives .sv-muted{opacity:.7}
.sentry-drives .sv-btn{all:unset;box-sizing:border-box;cursor:pointer;padding:5px 10px;border-radius:7px;border:1px solid rgba(127,127,127,.45);font-weight:600;font-size:13px;white-space:nowrap}
.sentry-drives .sv-btn[aria-pressed="true"]{background:rgba(127,127,127,.2)}
.sentry-drives .sv-btn:focus-visible,.sentry-drives .sv-drive:focus-visible{outline:2px solid currentColor;outline-offset:2px}
.sentry-drives select{font:inherit;font-size:13px;color:inherit;background:transparent;border:1px solid rgba(127,127,127,.45);border-radius:7px;padding:4px 6px}
.sentry-drives select option{color:#111;background:#fff}
.sentry-drives .sv-day{display:flex;flex-direction:column;gap:6px}
.sentry-drives .sv-dayhead{display:flex;flex-wrap:wrap;justify-content:space-between;gap:2px 12px;align-items:baseline;margin:4px 0 0;padding-bottom:4px;border-bottom:1px solid rgba(127,127,127,.25)}
.sentry-drives .sv-dayhead h3{margin:0;font-size:15px;font-weight:700}
.sentry-drives .sv-dayhead span{font-size:12px;opacity:.7;font-variant-numeric:tabular-nums}
.sentry-drives .sv-drive{all:unset;box-sizing:border-box;cursor:pointer;display:grid;grid-template-columns:auto minmax(0,1fr) auto auto;gap:4px 14px;align-items:center;width:100%;
  padding:10px 12px;border-radius:10px;border:1px solid rgba(127,127,127,.22);background:rgba(127,127,127,.06)}
.sentry-drives .sv-drive:hover{background:rgba(127,127,127,.14)}
.sentry-drives .sv-drive.sv-off{cursor:default}
.sentry-drives .sv-drive.sv-off:hover{background:rgba(127,127,127,.06)}
.sentry-drives .sv-shape{width:64px;height:44px;display:block}
.sentry-drives .sv-shape path{fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round;stroke-linejoin:round;opacity:.75}
.sentry-drives .sv-shape circle{fill:currentColor}
.sentry-drives .sv-shape .sv-a{fill:rgba(61,220,132,.9)}
.sentry-drives .sv-source{font-size:13px;padding:6px 10px;border-radius:8px;background:rgba(127,127,127,.1);min-width:0;overflow-wrap:anywhere}
.sentry-drives .sv-times{display:flex;flex-direction:column;font-variant-numeric:tabular-nums;font-weight:700;line-height:1.25;width:5.6em}
.sentry-drives .sv-times span:last-child{font-weight:500;opacity:.7}
.sentry-drives .sv-route{display:flex;flex-direction:column;min-width:0;gap:1px}
.sentry-drives .sv-route b{font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.sentry-drives .sv-route b i{font-style:normal;opacity:.6;font-weight:400;margin:0 6px}
.sentry-drives .sv-chips{display:flex;flex-wrap:wrap;gap:4px 6px;margin-top:3px}
.sentry-drives .sv-chip{font-size:12px;padding:1px 8px;border-radius:999px;background:rgba(127,127,127,.16);white-space:nowrap;font-variant-numeric:tabular-nums}
.sentry-drives .sv-chip.can{background:rgba(61,220,132,.22)}
.sentry-drives .sv-chip.warn{background:rgba(255,93,93,.2)}
.sentry-drives .sv-chip.at{background:rgba(255,211,74,.22)}
.sentry-drives .sv-chip.ap{background:rgba(90,160,255,.24)}
.sentry-drives .sv-chip.tag{background:transparent;border:1px solid rgba(127,127,127,.45)}
.sentry-drives .sv-play{width:30px;height:30px;border-radius:50%;display:grid;place-items:center;border:1px solid rgba(127,127,127,.45)}
.sentry-drives .sv-play svg{width:14px;height:14px;fill:currentColor;margin-left:2px}
@media (max-width:520px){
  .sentry-drives .sv-drive{grid-template-columns:auto minmax(0,1fr);padding:10px;gap:4px 12px}
  .sentry-drives .sv-play,.sentry-drives .sv-drive>.sv-end{display:none}
  .sentry-drives .sv-times{grid-column:1;grid-row:1}
  .sentry-drives .sv-route{grid-column:2;grid-row:1 / span 2}
  .sentry-drives .sv-shapebox{grid-column:1;grid-row:2;align-self:start}
  .sentry-drives .sv-shape{width:52px;height:36px}
  .sentry-drives .sv-route b{white-space:normal}
}
`;

const esc = (t) => String(t ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const GAP_KEY = 'sentry-drives-gap';
const GAPS = [2, 5, 10, 15, 30];
const read = (k, d) => { try { return localStorage.getItem(k) ?? d; } catch { return d; } };
const write = (k, v) => { try { localStorage.setItem(k, v); } catch { /* for this visit then */ } };
// miles or kilometres: the one choice every page uses (web/units.js), as the Driving page
const units = () => (globalThis.SentryUnits.metric() ? 'km' : 'mi');
const gapMin = () => { const g = Number(read(GAP_KEY, 5)); return GAPS.includes(g) ? g : 5; };
const fmtDist = (m, u) => { const x = u === 'km' ? m / 1000 : m / 1609.344; return `${x >= 100 ? Math.round(x) : x.toFixed(1)} ${u}`; };
const speed = (mps, u) => (u === 'km' ? `${Math.round(mps * 3.6)} km/h` : `${Math.round(mps * 2.23694)} mph`);
/** A drive's length in words: "1 h 25 min", "1 day"; under a minute "under 1 min". */
export const driveLength = (s) => (s > 0 && s < 60 ? 'under 1 min' : footMinutes(s / 60));
// the times are the car's clock (as the clip names): shown as they are
const asDate = (wall) => new Date(`${String(wall).replace(' ', 'T')}Z`);
const clockText = (wall, h24) => { try { return asDate(wall).toLocaleTimeString(undefined, { hour: h24 ? '2-digit' : 'numeric', minute: '2-digit', hour12: !h24, timeZone: 'UTC' }); } catch { return String(wall).slice(11, 16); } };
const dayText = (d) => { try { return asDate(`${d} 12:00:00`).toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' }); } catch { return d; } };
const where = (end) => (!end ? 'No GPS' : end.label || `${end.lat.toFixed(4)}, ${end.lon.toFixed(4)}`);
const pct = (x) => `${x >= 10 || x === 0 ? Math.round(x) : x.toFixed(1)}%`;
/** The route's shape, a small line drawing (no map tiles): north up, start dot green. */
function shapeSvg(route) {
  if (!Array.isArray(route) || route.length < 2) return '';
  const lat0 = route.reduce((n, p) => n + p[0], 0) / route.length;
  const k = Math.cos((lat0 * Math.PI) / 180) || 1;
  const xs = route.map((p) => p[1] * k);
  const ys = route.map((p) => -p[0]);
  const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
  const W = 64; const H = 44; const pad = 5;
  const span = Math.max(x1 - x0, y1 - y0, 1e-6);
  const sc = Math.min((W - 2 * pad) / Math.max(x1 - x0, span * 1e-3), (H - 2 * pad) / Math.max(y1 - y0, span * 1e-3));
  const ox = (W - (x1 - x0) * sc) / 2;
  const oy = (H - (y1 - y0) * sc) / 2;
  const pt = (i) => [ox + (xs[i] - x0) * sc, oy + (ys[i] - y0) * sc].map((v) => v.toFixed(1));
  const d = xs.map((_, i) => `${i ? 'L' : 'M'}${pt(i).join(' ')}`).join('');
  const [ax, ay] = pt(0);
  const [zx, zy] = pt(xs.length - 1);
  return `<svg class="sv-shape" viewBox="0 0 ${W} ${H}" aria-hidden="true"><path d="${d}"/><circle class="sv-a" cx="${ax}" cy="${ay}" r="3"/><circle cx="${zx}" cy="${zy}" r="3"/></svg>`;
}
const PLAY = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 4.5v15l12.5-7.5z"/></svg>';

export function createDrivesPage(el, { vehicleId, vehicleName = '', open = () => {}, h24 = () => false } = {}) {
  const clock = (wall) => clockText(wall, Boolean(h24()));
  if (!document.getElementById('sentry-drives-css')) {
    const style = document.createElement('style');
    style.id = 'sentry-drives-css';
    style.textContent = CSS;
    document.head.appendChild(style);
  }
  let alive = true;
  let drives = [];
  let next = null;
  let info = null;
  let loading = false;
  let error = '';
  let ask = 0;
  let again = null;
  el.innerHTML = '<div class="sentry-drives"><p class="sv-muted">Loading…</p></div>';
  const root = el.firstChild;

  function driveHtml(d, i, u) {
    const chips = [`<span class="sv-chip">${esc(driveLength(d.seconds))}</span>`];
    if (d.distance !== null) chips.push(`<span class="sv-chip">${esc(fmtDist(d.distance, u))}</span>`);
    if (d.top) chips.push(`<span class="sv-chip">top ${esc(speed(d.top, u))}</span>`);
    if (d.hardBrakes) chips.push(`<span class="sv-chip warn">${d.hardBrakes} hard brak${d.hardBrakes === 1 ? 'e' : 'es'}</span>`);
    if (d.swerves) chips.push(`<span class="sv-chip warn">${d.swerves} swerve${d.swerves === 1 ? '' : 's'}</span>`);
    const ap = d.autopilot;
    if (ap && ap.fsd >= 0.5) chips.push(`<span class="sv-chip ap" title="Full Self-Driving for ${esc(pct(ap.fsd))} of the distance (${esc(driveLength(ap.fsdSeconds))})">FSD ${esc(pct(ap.fsd))}</span>`);
    const auto = ap ? ap.autosteer + ap.tacc : 0;
    if (ap && auto >= 0.5) chips.push(`<span class="sv-chip ap" title="Autosteer ${esc(pct(ap.autosteer))} and Traffic-Aware Cruise Control ${esc(pct(ap.tacc))} of the distance">Autopilot ${esc(pct(auto))}</span>`);
    if (d.can) chips.push('<span class="sv-chip can" title="CAN Bridge car data for this drive">CAN</span>');
    for (const t of d.tags || []) chips.push(`<span class="sv-chip tag" title="Drive tag from Sentry USB">${esc(t)}</span>`);
    if (!d.open) chips.push('<span class="sv-chip" title="The clips of this drive are not in the footage here (deleted, or not copied yet)">no footage here</span>');
    if (d.distance === null) chips.push('<span class="sv-chip" title="The speeds of these clips have not been read yet (Footage → Index speeds)">distance not read yet</span>');
    const from = where(d.from);
    const to = where(d.to);
    const inner = `<span class="sv-times"><span>${esc(clock(d.start))}</span><span>${esc(clock(d.end))}</span></span>
      <span class="sv-route"><b>${esc(from)}<i aria-hidden="true">→</i>${esc(to)}</b>
        <span class="sv-chips">${chips.join('')}</span></span>
      <span class="sv-shapebox">${shapeSvg(d.route)}</span>`;
    if (!d.open) return `<div class="sv-drive sv-off" role="group" aria-label="${esc(`Drive from ${from} to ${to}, ${clock(d.start)} to ${clock(d.end)}, no footage here`)}">${inner}<span class="sv-end"></span></div>`;
    const label = `Play the drive from ${from} to ${to}, ${clock(d.start)} to ${clock(d.end)}`;
    return `<button type="button" class="sv-drive" data-i="${i}" aria-label="${esc(label)}">${inner}
      <span class="sv-play" aria-hidden="true">${PLAY}</span></button>`;
  }

  const when = (ms) => {
    try { return new Date(ms).toLocaleString(undefined, { day: 'numeric', month: 'short', year: 'numeric', hour: h24() ? '2-digit' : 'numeric', minute: '2-digit', hour12: !h24() }); } catch { return new Date(ms).toISOString().slice(0, 16).replace('T', ' '); }
  };
  // where the drives come from: Sentry USB's drive data, or the clips
  function sourceHtml() {
    if (!info) return '';
    const dd = info.driveData;
    if (info.source === 'sentry-usb') {
      const extra = dd?.reading ? ' A newer copy is being read.' : '';
      return `<div class="sv-source" data-source="sentry-usb">From Sentry USB's drive data${dd?.updatedAt ? `, updated ${esc(when(dd.readOf || dd.updatedAt))}` : ''}.${extra}</div>`;
    }
    let text = 'From your clips: the car\'s own recording (Recent clips) grouped into trips.';
    if (dd?.reading) text += ` Reading Sentry USB's drive data${dd.progress ? ` (${dd.progress}%)` : ''}; its drives show here when it is done.`;
    else if (dd?.error) text += ` Sentry USB's drive data on the share could not be read (${esc(dd.error)}); it is tried again when it changes.`;
    return `<div class="sv-source" data-source="clips">${text}</div>`;
  }

  function draw() {
    if (!alive) return;
    const u = units();
    const g = gapMin();
    const days = new Map();
    drives.forEach((d, i) => {
      if (!days.has(d.date)) days.set(d.date, []);
      days.get(d.date).push([d, i]);
    });
    const head = `<div class="sv-row"><span class="sv-grow sv-muted">${esc(vehicleName)}${vehicleName ? ' · ' : ''}trips, newest first${info?.source !== 'sentry-usb' && info?.indexing ? ' (distances fill in as the footage is read)' : ''}</span>
      <label class="sv-row" style="gap:6px"><span class="sv-muted">New drive after a stop of</span><select data-gap aria-label="New drive after a stop of">${GAPS.map((x) => `<option value="${x}"${x === g ? ' selected' : ''}>${x} min</option>`).join('')}</select></label>
      <span class="sv-row" role="group" aria-label="Distance in" style="gap:6px"><button type="button" class="sv-btn" data-u="mi" aria-pressed="${u === 'mi'}">Miles</button><button type="button" class="sv-btn" data-u="km" aria-pressed="${u === 'km'}">Kilometres</button></span></div>${sourceHtml()}`;
    let body = '';
    if (!drives.length && loading) body = '<p class="sv-muted">Loading…</p>';
    else if (!drives.length && error) body = `<p>${esc(error)}</p>`;
    else if (!drives.length) body = `<p class="sv-muted">No drives yet. A drive is the car's own recording (Recent clips) grouped into trips; Sentry and Saved events are not drives.${info?.scanning ? ' The footage is still being read.' : ''}</p>`;
    else {
      body = [...days].map(([day, list]) => {
        const secs = list.reduce((n, [d]) => n + d.seconds, 0);
        const known = list.filter(([d]) => d.distance !== null);
        const dist = known.reduce((n, [d]) => n + d.distance, 0);
        return `<section class="sv-day" aria-label="${esc(dayText(day))}"><div class="sv-dayhead"><h3>${esc(dayText(day))}</h3>
          <span>${list.length} drive${list.length === 1 ? '' : 's'} · ${esc(driveLength(secs))}${known.length ? ` · ${esc(fmtDist(dist, u))}` : ''}</span></div>
          ${list.map(([d, i]) => driveHtml(d, i, u)).join('')}</section>`;
      }).join('');
      if (next) body += `<div><button type="button" class="sv-btn" data-more${loading ? ' disabled' : ''}>${loading ? 'Loading…' : 'Show older drives'}</button></div>`;
      if (error) body += `<p>${esc(error)}</p>`;
    }
    root.innerHTML = head + body;
  }

  async function load(more = false) {
    if (!vehicleId) return;
    const me = ++ask;
    loading = true;
    error = '';
    draw();
    const q = new URLSearchParams({ limit: '40', gap: String(gapMin()) });
    if (more && next) q.set('before', next);
    try {
      const r = await fetch(`/api/vehicles/${encodeURIComponent(vehicleId)}/drives?${q}`, { credentials: 'same-origin' });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || 'Could not load the drives.');
      if (!alive || me !== ask) return;
      drives = more ? drives.concat(d.drives) : d.drives;
      next = d.more ? d.next : null;
      info = d;
      // Sentry USB's drive data is being read: look again in a while (the first page only)
      clearTimeout(again);
      if (d.reading && !more && drives.length <= 40) again = setTimeout(() => { if (alive && !loading) load(); }, 5000);
    } catch (err) {
      if (!alive || me !== ask) return;
      error = err.message;
    }
    loading = false;
    draw();
  }

  root.addEventListener('click', (e) => {
    const b = e.target.closest('[data-u]');
    if (b) { globalThis.SentryUnits.set(b.dataset.u === 'km'); draw(); return; }
    if (e.target.closest('[data-more]')) { if (!loading) load(true); return; }
    const row = e.target.closest('.sv-drive');
    if (row) {
      const d = drives[Number(row.dataset.i)];
      if (d?.open) open(d.open, d);
    }
  });
  root.addEventListener('change', (e) => {
    if (!e.target.matches('[data-gap]')) return;
    write(GAP_KEY, e.target.value);
    drives = [];
    next = null;
    load();
  });

  if (!vehicleId) root.innerHTML = '<p class="sv-muted">Add a vehicle first.</p>';
  else load();
  return { destroy() { alive = false; clearTimeout(again); el.innerHTML = ''; } };
}
