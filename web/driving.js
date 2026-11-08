// Driving, the same in every interface: a vehicle's driving week by week
// (GET /api/vehicles/:id/driving): distance as bars, and a table with time
// moving, hard braking and swerves (each about 0.4 g or more), top speed and
// days driven. Plain markup (sentry-driving-*), colours inherited from the
// page; the bars use the page's text colour.
//
//   const page = createDrivingPage(el, { vehicleId, vehicleName });
import { footMinutes } from '/web/duration.js';


const CSS = `
.sentry-driving{display:flex;flex-direction:column;gap:18px;font-size:14px;line-height:1.45}
.sentry-driving .sd-row{display:flex;flex-wrap:wrap;gap:8px 18px;align-items:baseline}
.sentry-driving .sd-muted{opacity:.7}
.sentry-driving .sd-big{display:flex;flex-wrap:wrap;gap:10px 28px}
.sentry-driving .sd-big div{display:flex;flex-direction:column}
.sentry-driving .sd-big b{font-size:24px;font-variant-numeric:tabular-nums;line-height:1.15}
.sentry-driving .sd-btn{all:unset;box-sizing:border-box;cursor:pointer;padding:5px 10px;border-radius:7px;border:1px solid rgba(127,127,127,.45);font-weight:600}
.sentry-driving .sd-btn[aria-pressed="true"]{background:rgba(127,127,127,.2)}
.sentry-driving .sd-btn:focus-visible{outline:2px solid currentColor;outline-offset:2px}
.sentry-driving svg{width:100%;height:auto;display:block;overflow:visible}
.sentry-driving svg text{fill:currentColor;font-size:11px}
.sentry-driving svg .bar{fill:currentColor;opacity:.75}
.sentry-driving svg .bar.now{opacity:1}
.sentry-driving svg .axis{stroke:currentColor;opacity:.25}
.sentry-driving .sd-scroll{overflow-x:auto}
.sentry-driving table{border-collapse:collapse;width:100%;min-width:560px;font-variant-numeric:tabular-nums}
.sentry-driving th,.sentry-driving td{padding:6px 10px 6px 0;text-align:right;border-top:1px solid rgba(127,127,127,.2);white-space:nowrap}
.sentry-driving th:first-child,.sentry-driving td:first-child{text-align:left}
.sentry-driving th{font-size:12px;opacity:.75;font-weight:600}
`;

const esc = (t) => String(t ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const UNIT_KEY = 'sentry-driving-units';
function units() { try { return localStorage.getItem(UNIT_KEY) === 'km' ? 'km' : 'mi'; } catch { return 'mi'; } }
function setUnits(u) { try { localStorage.setItem(UNIT_KEY, u); } catch { /* per visit then */ } }
const dist = (m, u) => (u === 'km' ? m / 1000 : m / 1609.344);
const fmtDist = (m, u) => { const x = dist(m, u); return `${x >= 100 ? Math.round(x) : x.toFixed(1)} ${u}`; };
const speed = (mps, u) => (u === 'km' ? `${Math.round(mps * 3.6)} km/h` : `${Math.round(mps * 2.23694)} mph`);
const hours = (s) => footMinutes(s / 60);
const weekText = (d) => { try { return new Date(`${d}T12:00:00`).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }); } catch { return d; } };

export function createDrivingPage(el, { vehicleId, vehicleName = '' } = {}) {
  if (!document.getElementById('sentry-driving-css')) {
    const style = document.createElement('style');
    style.id = 'sentry-driving-css';
    style.textContent = CSS;
    document.head.appendChild(style);
  }
  let data = null;
  let alive = true;
  el.innerHTML = '<div class="sentry-driving"><p class="sd-muted">Loading…</p></div>';
  const root = el.firstChild;

  function draw() {
    if (!alive || !data) return;
    const u = units();
    const weeks = data.weeks;
    const now = weeks[weeks.length - 1];
    const prev = weeks[weeks.length - 2];
    const max = Math.max(1, ...weeks.map((w) => w.distance));
    const W = 640;
    const Hh = 180;
    const bw = W / weeks.length;
    const any = weeks.some((w) => w.distance > 0);
    const change = prev && prev.distance > 0 ? Math.round(((now.distance - prev.distance) / prev.distance) * 100) : null;
    root.innerHTML = `
      <div class="sd-row"><span class="sd-muted">${esc(vehicleName)}${vehicleName ? ' · ' : ''}the last ${weeks.length} weeks, from the driving data in the footage</span>
        <span class="sd-row" role="group" aria-label="Distance in"><button type="button" class="sd-btn" data-u="mi" aria-pressed="${u === 'mi'}">Miles</button><button type="button" class="sd-btn" data-u="km" aria-pressed="${u === 'km'}">Kilometres</button></span></div>
      <div class="sd-big">
        <div><span class="sd-muted">This week</span><b>${esc(fmtDist(now.distance, u))}</b><span class="sd-muted">${change === null ? '' : `${change >= 0 ? '+' : ''}${change}% on last week`}</span></div>
        <div><span class="sd-muted">Moving</span><b>${esc(hours(now.driving))}</b><span class="sd-muted">${now.days} day${now.days === 1 ? '' : 's'} driven</span></div>
        <div><span class="sd-muted">Hard braking</span><b>${now.hardBrakes}</b><span class="sd-muted">${now.swerves} swerve${now.swerves === 1 ? '' : 's'} or sharp turn${now.swerves === 1 ? '' : 's'}</span></div>
        <div><span class="sd-muted">Top speed</span><b>${esc(now.top ? speed(now.top, u) : '—')}</b></div>
      </div>
      ${any ? `<svg viewBox="0 0 ${W} ${Hh + 24}" role="img" aria-label="Distance driven each week">
        <line class="axis" x1="0" x2="${W}" y1="${Hh}" y2="${Hh}"></line>
        ${weeks.map((w, i) => {
          const h = Math.round((w.distance / max) * (Hh - 18));
          const x = i * bw + bw * 0.15;
          return `<g><title>Week of ${esc(weekText(w.week))}: ${esc(fmtDist(w.distance, u))}</title>
            <rect class="bar${i === weeks.length - 1 ? ' now' : ''}" x="${x.toFixed(1)}" y="${Hh - h}" width="${(bw * 0.7).toFixed(1)}" height="${h}" rx="2"></rect>
            ${w.distance ? `<text x="${(x + bw * 0.35).toFixed(1)}" y="${Hh - h - 4}" text-anchor="middle">${esc(Math.round(dist(w.distance, u)))}</text>` : ''}
            ${i % 2 === weeks.length % 2 || weeks.length <= 8 ? `<text x="${(x + bw * 0.35).toFixed(1)}" y="${Hh + 16}" text-anchor="middle" opacity=".7">${esc(weekText(w.week))}</text>` : ''}</g>`;
        }).join('')}</svg>` : '<p class="sd-muted">No driving data yet. It is read from the footage in the background (Footage → Index speeds shows how far along it is).</p>'}
      <div class="sd-scroll"><table><thead><tr><th>Week of</th><th>Distance</th><th>Moving</th><th>Days</th><th>Hard braking</th><th>Swerves</th><th>Top speed</th></tr></thead>
        <tbody>${[...weeks].reverse().map((w) => `<tr><td>${esc(weekText(w.week))}</td><td>${w.distance ? esc(fmtDist(w.distance, u)) : '—'}</td><td>${w.driving ? esc(hours(w.driving)) : '—'}</td>
          <td>${w.days || '—'}</td><td>${w.hardBrakes || '—'}</td><td>${w.swerves || '—'}</td><td>${w.top ? esc(speed(w.top, u)) : '—'}</td></tr>`).join('')}</tbody></table></div>`;
  }

  root.addEventListener('click', (e) => {
    const b = e.target.closest('[data-u]');
    if (b) { setUnits(b.dataset.u); draw(); }
  });

  if (!vehicleId) root.innerHTML = '<p class="sd-muted">Add a vehicle first.</p>';
  else {
    fetch(`/api/vehicles/${encodeURIComponent(vehicleId)}/driving?weeks=12`, { credentials: 'same-origin' })
      .then(async (r) => { const d = await r.json(); if (!r.ok) throw new Error(d.error || 'Could not load.'); data = d; draw(); })
      .catch((err) => { if (alive) root.innerHTML = `<p>${esc(err.message)}</p>`; });
  }
  return { destroy() { alive = false; el.innerHTML = ''; } };
}
