import { ownedRender } from '../core.js';
import { esc } from '../core.js';
import { overviewStatus, strip, spaceTone } from '../status.js';
import {
  dayLabel,
  size,
  ago,
  duration,
  plural,
  categoryEntries,
  categoryCount,
} from '../format.js';
async function renderPage(el, ctx) {
  const { api } = ctx.scope;
  const { current, state, alive } = ctx;
  const v = current();
  if (!v) {
    el.innerHTML =
      '<h2 class="hero">Add your first vehicle to get started.</h2><a class="btn primary" href="#/settings/vehicles">Add a vehicle</a>';
    return;
  }
  const [d, h, j] = await Promise.all([
    api(`/api/vehicles/${encodeURIComponent(v.id)}/days?limit=40`),
    api('/api/health'),
    api('/api/jobs'),
  ]);
  if (!alive()) return;
  const days = d.days || [],
    checks = h.checks || [],
    status = overviewStatus({
      vehicle: v,
      notes: state.notes,
      checks,
      days,
      vehicleCount: state.vehicles?.length || 1,
    }),
    inv = v.inventory || {},
    s = v.storage,
    // a phone shows two weeks, wide enough to tap a day; wider screens five weeks
    cells = strip(days, new Date(), globalThis.matchMedia?.('(max-width: 760px)').matches ? 14 : 36),
    max = Math.max(1, ...cells.map((c) => c.drives + c.other)),
    jobs = (j.jobs || []).filter(
      (j) => j.vehicleId === v.id && ['running', 'waiting', 'paused'].includes(j.status),
    );
  el.innerHTML = `<h2 class="hero ${status.tone === 'bad' ? 'bad' : ''}">${esc(status.first)} <span class="${status.tone === 'warn' ? 'warn' : ''}">${esc(status.second)}</span></h2><p class="hero-sub">${status.sub ? esc(status.sub) + ' · ' : ''}${plural(inv.recordings, 'recording')} over ${plural(inv.days, 'day')} · checked ${ago(inv.scannedAt)}</p>
 <section class="card"><div class="row"><h3 class="grow">What happened lately</h3><a href="#/footage">Open Footage</a></div><div class="day-strip" style="--strip-days:${cells.length}">${cells.map((c) => `<a class="strip-cell ${c.state}" title="${esc(dayLabel(c.day))}" aria-label="${esc(dayLabel(c.day))}: ${plural(c.drives + c.other, 'recording')}" href="#/footage?from=${c.day}&to=${c.day}"><span style="height:${(100 * c.saved) / max}%;background:var(--saved)"></span><span style="height:${(100 * c.sentry) / max}%;background:var(--sentry)"></span><span style="height:${(100 * c.drives) / max}%;background:var(--driving)"></span></a>`).join('')}</div><div class="row muted"><small class="grow">${dayLabel(cells[0].day)}</small><small>Today</small></div><p class="strip-legend"><span><i style="color:var(--driving)">●</i> Driving</span><span><i style="color:var(--sentry)">●</i> Sentry</span><span><i style="color:var(--saved)">●</i> Saved</span><span>◌ No footage</span></p><div class="latest-days">${days
   .slice(0, 5)
   .map(
     (d) =>
       `<a class="latest" href="#/viewer?day=${d.day}"><span class="latest-image"><img alt="" src="/api/vehicles/${encodeURIComponent(v.id)}/recordings/${encodeURIComponent(d.thumbId)}/thumbnail"><i>▶</i></span><div><b>${esc(dayLabel(d.day))}</b><p>${categoryEntries(
         d.byCategory || {},
       )
         .map(([k, n]) => esc(categoryCount(k, n)))
         .join(
           ' · ',
         )} · ${duration(d.minutes)}</p>${d.archive?.state === 'filling' ? '<small>Still arriving</small>' : ''}</div></a>`,
   )
   .join('')}</div></section>
 <div class="grid"><section class="card"><div class="row"><h3 class="grow">Footage</h3><a href="#/footage">Browse</a></div><div class="number">${plural(inv.recordings, 'recording')}</div><p>over ${plural(inv.days, 'day')}${inv.firstDay ? ', since ' + dayLabel(inv.firstDay) : ''}</p><div class="category-bar">${categoryEntries(
   inv.byCategory || {},
 )
   .map(([k, c]) => `<span class="category-${esc(k)}" style="flex:${c.recordings}"></span>`)
   .join('')}</div>${categoryEntries(inv.byCategory || {})
   .map(
     ([k, c]) =>
       `<div class="row"><span class="grow category-text-${esc(k)}">${k === 'Recent' ? 'Driving' : esc(k)}</span><span class="mono">${Number(c.recordings || 0).toLocaleString()} · ${size(c.bytes)}</span></div>`,
   )
   .join(
     '',
   )}</section><section class="card space-card space-${spaceTone(v, checks)}"><h3>Space</h3>${s ? `<div class="space-heading"><span class="space-ring" style="--used:${Math.max(0, Math.min(100, 100 * (1 - s.free / s.total)))}%" aria-label="${Math.round((100 * s.free) / s.total)}% free"></span><div><div class="number">${size(s.free)} free</div><p>of ${size(s.total)} on the share</p></div></div><p>Grows about ${size(s.perDay)} a day</p>${s.daysLeft != null ? `<span class="tag">About ${plural(s.daysLeft, 'day')} left</span>` : ''}` : '<p>Space information is unavailable.</p>'}</section><section class="card"><div class="row"><h3 class="grow">Activity</h3><a href="#/activity">See all</a></div><div class="number">${jobs.length ? 'Running' : 'Idle'}</div><p>${jobs.length ? `${plural(jobs.length, 'active job')}` : 'Nothing is running right now'}</p><p>${size(v.saved?.bytes || 0)} saved by converting ${plural(v.saved?.clips, 'clip')}</p><a class="muted" href="#/bin">${v.binItems ? `Recycle Bin: ${plural(v.binItems, 'item')} · ${size(v.binBytes || 0)}` : 'Recycle Bin is empty'}</a><p>Last scan ${ago(inv.scannedAt)}</p></section></div>`;
  el.querySelectorAll('img').forEach(
    (img) =>
      (img.onerror = () => {
        img.hidden = true;
      }),
  );
}

export const render = ownedRender(renderPage);
