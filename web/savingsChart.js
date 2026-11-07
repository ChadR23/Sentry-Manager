// Saved by converting, month by month: a vehicle's space won back by
// conversions in each of the last 12 months (GET
// /api/vehicles/:id/savings-by-month), as bars with the value on each, and
// the total. On every interface's main page; colours follow the page.
//
//   const chart = createSavingsChart(el, { vehicleId });
//   watchSavingsCharts(document.body);   // fills every <div data-savings-chart="vehicle id">, also ones a page draws later

const STYLE = `
.sentry-sv{display:flex;flex-direction:column;gap:8px;font-size:13px;line-height:1.4}
.sentry-sv .sv-head{display:flex;flex-wrap:wrap;gap:4px 14px;align-items:baseline}
.sentry-sv .sv-head b{font-size:15px}
.sentry-sv .sv-muted{opacity:.7}
.sentry-sv svg{width:100%;height:auto;display:block;overflow:visible}
.sentry-sv svg text{fill:currentColor;font-size:10.5px}
.sentry-sv svg .bar{fill:currentColor;opacity:.72}
.sentry-sv svg .bar.now{opacity:1}
.sentry-sv svg .axis{stroke:currentColor;opacity:.25}
`;
const size = (b) => (b >= 1024 ** 4 ? `${(b / 1024 ** 4).toFixed(1)} TB` : b >= 1024 ** 3 ? `${(b / 1024 ** 3).toFixed(b >= 10 * 1024 ** 3 ? 0 : 1)} GB` : b >= 1024 ** 2 ? `${Math.round(b / 1024 ** 2)} MB` : b > 0 ? `${Math.max(1, Math.round(b / 1024))} KB` : '0');
const short = (b) => (b >= 1024 ** 4 ? `${(b / 1024 ** 4).toFixed(1)}T` : b >= 1024 ** 3 ? `${(b / 1024 ** 3).toFixed(b >= 10 * 1024 ** 3 ? 0 : 1)}G` : b >= 1024 ** 2 ? `${Math.round(b / 1024 ** 2)}M` : '');
const monthName = (m, long = false) => { try { return new Date(`${m}-15T12:00:00`).toLocaleDateString(undefined, long ? { month: 'long', year: 'numeric' } : { month: 'short' }); } catch { return m; } };
const esc = (t) => String(t ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// a minute's cache: pages that redraw themselves often do not ask again each time
const cache = new Map(); // vehicle -> { at, promise }
function load(vehicleId) {
  const had = cache.get(vehicleId);
  if (had && Date.now() - had.at < 60_000) return had.promise;
  const promise = fetch(`/api/vehicles/${encodeURIComponent(vehicleId)}/savings-by-month`, { credentials: 'same-origin' })
    .then((r) => (r.ok ? r.json() : Promise.reject(new Error('Could not load the savings.'))));
  promise.catch(() => cache.delete(vehicleId));
  cache.set(vehicleId, { at: Date.now(), promise });
  return promise;
}

/** Fill every [data-savings-chart] placeholder under root, now and when pages draw new ones. */
export function watchSavingsCharts(root = document.body) {
  const fill = () => {
    for (const el of root.querySelectorAll('[data-savings-chart]:not([data-sv-done])')) {
      el.setAttribute('data-sv-done', '');
      createSavingsChart(el, { vehicleId: el.getAttribute('data-savings-chart') });
    }
  };
  fill();
  let queued = false;
  // only when elements were added (a ticking clock or progress text adds text nodes only)
  new MutationObserver((list) => {
    if (queued || !list.some((m) => [...m.addedNodes].some((n) => n.nodeType === 1))) return;
    queued = true;
    requestAnimationFrame(() => { queued = false; fill(); });
  }).observe(root, { childList: true, subtree: true });
}

export function createSavingsChart(el, { vehicleId } = {}) {
  if (!el) return { destroy() {} };
  if (!document.getElementById('sentry-sv-css')) {
    const style = document.createElement('style');
    style.id = 'sentry-sv-css';
    style.textContent = STYLE;
    document.head.appendChild(style);
  }
  const box = document.createElement('div');
  box.className = 'sentry-sv';
  el.appendChild(box);
  let alive = true;
  if (!vehicleId) { box.innerHTML = '<p class="sv-muted">Add a vehicle first.</p>'; return { destroy() { box.remove(); } }; }
  load(vehicleId)
    .then(({ months, total }) => {
      if (!alive) return;
      const max = Math.max(1, ...months.map((m) => m.bytes));
      const now = months[months.length - 1];
      const W = 600;
      const H = 120;
      const bw = W / months.length;
      const any = months.some((m) => m.bytes > 0);
      box.innerHTML = `<div class="sv-head"><span><b>${esc(size(now.bytes))}</b> <span class="sv-muted">saved this month</span></span>
        <span class="sv-muted">${esc(size(total.bytes))} in all${total.clips ? ` · ${total.clips.toLocaleString()} clips converted` : ''}</span></div>
        ${any ? `<svg viewBox="0 0 ${W} ${H + 20}" role="img" aria-label="Space saved by converting, each month">
          <line class="axis" x1="0" x2="${W}" y1="${H}" y2="${H}"></line>
          ${months.map((m, i) => {
            const h = Math.round((m.bytes / max) * (H - 16));
            const x = i * bw + bw * 0.15;
            return `<g><title>${esc(monthName(m.month, true))}: ${esc(size(m.bytes))}${m.clips ? `, ${m.clips} clips` : ''}</title>
              <rect class="bar${i === months.length - 1 ? ' now' : ''}" x="${x.toFixed(1)}" y="${H - h}" width="${(bw * 0.7).toFixed(1)}" height="${h}" rx="2"></rect>
              ${m.bytes ? `<text x="${(x + bw * 0.35).toFixed(1)}" y="${H - h - 4}" text-anchor="middle">${esc(short(m.bytes))}</text>` : ''}
              <text x="${(x + bw * 0.35).toFixed(1)}" y="${H + 14}" text-anchor="middle" opacity=".7">${esc(monthName(m.month))}</text></g>`;
          }).join('')}</svg>` : '<p class="sv-muted" style="margin:0">Nothing converted in the last 12 months yet.</p>'}`;
    })
    .catch((err) => { if (alive) box.innerHTML = `<p class="sv-muted">${esc(err.message)}</p>`; });
  return { destroy() { alive = false; box.remove(); } };
}
