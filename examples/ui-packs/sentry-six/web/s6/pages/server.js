import { api, esc, act, toast } from '../core.js';
import { serverBody, hostLine } from '../serverStats.js';
export async function render(el, ctx) {
  let range = '15m',
    snap = null,
    hist = null,
    stopped = false,
    timer = null,
    loading = false;
  const more = {},
    seen = new Map();
  el.innerHTML =
    '<a class="back" href="#/health">‹ Health</a><h2>Server details</h2><p data-host></p><div class="toolbar"><div class="segments"><button data-range="15m" class="active">15 min</button><button data-range="24h">24 h</button></div><a data-csv download>Download CSV</a></div><div class="nd-grid" data-stats>Reading the server…</div>';
  function draw() {
    if (stopped || !ctx.alive()) return;
    el.querySelector('[data-host]').innerHTML = hostLine(snap?.host);
    el.querySelector('[data-stats]').innerHTML = snap
      ? serverBody(snap, { range, hist, more, seen })
      : 'Waiting for a sample…';
    el.querySelector('[data-csv]').href = '/api/stats/export.csv?range=' + range;
    el.querySelectorAll('[data-range]').forEach((b) =>
      b.classList.toggle('active', b.dataset.range === range),
    );
  }
  async function poll() {
    clearTimeout(timer);
    if (stopped || !ctx.alive() || document.hidden || loading) return;
    loading = true;
    try {
      const values = await Promise.all([
        api('/api/stats'),
        range === '24h' ? api('/api/stats/history?range=24h') : null,
      ]);
      snap = values[0];
      hist = values[1];
      draw();
    } catch (e) {
      if (!stopped && ctx.alive()) toast(e.message, true);
    } finally {
      loading = false;
      if (!stopped && ctx.alive() && !document.hidden) timer = setTimeout(poll, 2000);
    }
  }
  el.onclick = act(async (e) => {
    const b = e.target.closest('[data-range]'),
      m = e.target.closest('[data-nd-more]');
    if (b) {
      range = b.dataset.range;
      seen.clear();
      await poll();
    }
    if (m) {
      more[m.dataset.ndMore] = !more[m.dataset.ndMore];
      draw();
    }
  });
  const visible = () => {
    clearTimeout(timer);
    if (!document.hidden) poll();
  };
  document.addEventListener('visibilitychange', visible);
  await poll();
  return () => {
    stopped = true;
    clearTimeout(timer);
    el.onclick = null;
    document.removeEventListener('visibilitychange', visible);
  };
}
