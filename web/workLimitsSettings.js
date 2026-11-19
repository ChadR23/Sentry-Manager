// Settings → Advanced → Background work, the same in every interface that
// shows it (admins only: /api/settings/work-limits answers nobody else). How
// many clips the background jobs handle at once, picked from the memory and
// CPUs this server's container has (server/workLimits.js), with why; an
// admin can type a number for any of them, and an empty box is automatic.
// Plain markup (sentry-wl-*), colours inherited; the interface passes its
// own button and input classes.
//
//   const w = createWorkLimitsSettings(el, { cls: { btn, primary, input }, toast, scope });
//   w.destroy();

const STYLE = `
.sentry-wl{display:flex;flex-direction:column;gap:12px;font-size:14px;line-height:1.5;min-width:0}
.sentry-wl p{margin:0}
.sentry-wl .wl-muted{opacity:.74}
.sentry-wl .wl-small{font-size:12.5px}
.sentry-wl .wl-list{display:flex;flex-direction:column;margin:0;padding:0;list-style:none}
.sentry-wl .wl-list li{display:grid;grid-template-columns:minmax(0,1fr) 96px;gap:4px 14px;align-items:center;padding:10px 0;border-top:1px solid rgba(127,127,127,.22)}
.sentry-wl .wl-list li:first-child{border-top:0}
.sentry-wl .wl-list b{font-weight:600}
.sentry-wl .wl-in{box-sizing:border-box;padding:7px 9px;border-radius:7px;border:1px solid rgba(127,127,127,.45);background:transparent;color:inherit;font:inherit;width:100%;min-width:0}
.sentry-wl .wl-row{display:flex;flex-wrap:wrap;gap:8px 12px;align-items:center}
.sentry-wl .wl-btn{all:unset;box-sizing:border-box;cursor:pointer;padding:7px 12px;border-radius:7px;border:1px solid rgba(127,127,127,.45);font-weight:600;white-space:nowrap;text-align:center}
.sentry-wl .wl-btn:hover{background:rgba(127,127,127,.14)}
.sentry-wl .wl-btn:focus-visible{outline:2px solid currentColor;outline-offset:2px}
.sentry-wl .wl-tag{display:inline-block;font-size:11px;font-weight:700;padding:1px 8px;border-radius:999px;background:rgba(127,127,127,.18);white-space:nowrap;vertical-align:1px}
.sentry-wl .wl-err{color:#e5484d}
`;
const esc = (t) => String(t ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const H = { 'Content-Type': 'application/json', 'X-Requested-With': 'sentry-six-manager' };
async function request(url, opts = {}) {
  const r = await fetch(url, { credentials: 'same-origin', ...opts, headers: { ...H, ...(opts.headers || {}) } });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(d.error || `That did not work (${r.status}).`), { status: r.status });
  return d;
}
const ROWS = [
  ['speedIndex', 'Speed index', 'Clips read at once for the speed graph and place search, at most (it starts at one and adds more while the server keeps up).'],
  ['codecChecks', 'Codec checks', 'Clips whose video format is read at once after a scan.'],
  ['scrubPreviews', 'Scrub previews', 'Viewer timeline previews made at once.'],
  ['telemetryReads', 'Car data reads', 'Clips whose car data (every frame) is read at once for the dashboard.'],
  ['thumbnails', 'Thumbnails', 'Recording card pictures and Studio clip previews made at once.'],
];
const SIZES = { small: 'a small server', medium: 'a mid-size server', big: 'a full-size server' };
const gb = (b) => `${(b / 1024 ** 3).toFixed(1)} GB`;

export function createWorkLimitsSettings(el, { cls = {}, toast = null, scope } = {}) {
  const api = async (url, opts = {}) => {
    scope?.check();
    try { return await request(url, { ...opts, signal: scope?.signal }); }
    finally { scope?.check(); }
  };
  if (!document.getElementById('sentry-wl-css')) {
    const style = document.createElement('style');
    style.id = 'sentry-wl-css';
    style.textContent = STYLE;
    document.head.appendChild(style);
  }
  const btn = cls.btn || 'wl-btn';
  const primary = cls.primary || btn;
  const input = `wl-in${cls.input ? ` ${cls.input}` : ''}`;
  let alive = true;
  el.classList.add('sentry-wl');

  function draw(w, error = '') {
    const r = w.resources;
    const from = (x) => (x === 'container' ? 'the container limit' : 'this machine');
    el.innerHTML = `<p>Picked for ${esc(SIZES[w.tier] || w.tier)}: <b>${esc(gb(r.memoryBytes))}</b> of memory (${from(r.memoryFrom)}) and <b>${esc(r.cpus)}</b> CPU${r.cpus === 1 ? '' : 's'} (${from(r.cpusFrom)}). Leave a box empty to keep it automatic.</p>
<form class="wl-form" novalidate><ul class="wl-list">${ROWS.map(([k, label, help]) => `<li><span><b>${esc(label)}</b> ${w.override[k] ? '<span class="wl-tag">Set by hand</span>' : ''}<br><span class="wl-muted wl-small">${esc(help)}</span></span><input class="${input}" type="number" inputmode="numeric" min="1" max="${w.max[k]}" step="1" name="${k}" value="${w.override[k] ?? ''}" placeholder="Auto: ${w.auto[k]}" aria-label="${esc(label)} (automatic: ${w.auto[k]})"></li>`).join('')}</ul>
${error ? `<p class="wl-err">${esc(error)}</p>` : ''}<div class="wl-row"><button class="${primary}" type="submit">Save</button><button class="${btn}" type="button" data-auto ${Object.keys(w.override).length ? '' : 'disabled'}>All automatic</button><span class="wl-muted wl-small">In use now: ${ROWS.map(([k, label]) => `${esc(label.toLowerCase())} ${w.limits[k]}`).join(', ')}.</span></div></form>`;
    const form = el.querySelector('form');
    const save = async (body) => {
      try {
        const next = await api('/api/settings/work-limits', { method: 'PUT', body: JSON.stringify(body) });
        if (!alive) return;
        draw(next);
        toast?.('Background work limits saved.');
      } catch (e) {
        if (alive && e.name !== 'AbortError') draw(w, e.message);
      }
    };
    form.onsubmit = (e) => {
      e.preventDefault();
      save(Object.fromEntries(ROWS.map(([k]) => [k, form.elements[k].value.trim() || null])));
    };
    el.querySelector('[data-auto]').onclick = () => save({});
  }

  api('/api/settings/work-limits').then((w) => { if (alive) draw(w); }, (e) => {
    if (alive && e.name !== 'AbortError') el.innerHTML = `<p class="wl-err">${esc(e.message)}</p>`;
  });
  return {
    destroy() {
      alive = false;
      el.classList.remove('sentry-wl');
      el.innerHTML = '';
    },
  };
}
