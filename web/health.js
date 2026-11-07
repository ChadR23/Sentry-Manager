// Settings → Health, the same in every interface: checks with what to do
// about them, database snapshots (make one, restore one), log search by date
// with a download, and the support bundle. Plain markup with classes
// (sentry-health-*), colours inherited from the page.
//
//   const page = createHealthPage(el);   // page.destroy() when leaving

const CSS = `
.sentry-health{display:flex;flex-direction:column;gap:22px;font-size:14px;line-height:1.45}
.sentry-health section{display:flex;flex-direction:column;gap:8px}
.sentry-health h2{margin:0;font-size:17px}
.sentry-health .sh-row{display:flex;flex-wrap:wrap;gap:8px;align-items:center}
.sentry-health .sh-muted{opacity:.7}
.sentry-health .sh-btn{all:unset;box-sizing:border-box;cursor:pointer;padding:7px 12px;border-radius:7px;border:1px solid rgba(127,127,127,.45);font-weight:600;white-space:nowrap}
.sentry-health .sh-btn:hover{background:rgba(127,127,127,.14)}
.sentry-health .sh-btn:focus-visible{outline:2px solid currentColor;outline-offset:2px}
.sentry-health .sh-btn[disabled]{opacity:.5;cursor:default}
.sentry-health input,.sentry-health select{box-sizing:border-box;padding:6px 8px;border-radius:7px;border:1px solid rgba(127,127,127,.45);background:transparent;color:inherit;font:inherit;min-width:0}
.sentry-health select option{color:#111}
.sentry-health .sh-group{margin-top:6px;font-weight:700;font-size:12px;letter-spacing:.05em;text-transform:uppercase;opacity:.75}
.sentry-health .sh-check{display:grid;grid-template-columns:auto 1fr;gap:2px 10px;padding:7px 0;border-top:1px solid rgba(127,127,127,.2)}
.sentry-health .sh-chip{grid-row:span 3;align-self:start;min-width:44px;text-align:center;font-size:11px;font-weight:800;letter-spacing:.04em;padding:2px 6px;border-radius:5px;color:#fff}
.sentry-health .sh-ok{background:#1f8a4c}.sentry-health .sh-warn{background:#b7791f}.sentry-health .sh-bad{background:#c0392b}.sentry-health .sh-skip{background:#6b7280}
.sentry-health .sh-detail{opacity:.8;overflow-wrap:anywhere}
.sentry-health .sh-hint{font-size:13px;opacity:.85}
.sentry-health table{border-collapse:collapse;width:100%}
.sentry-health td{padding:6px 8px 6px 0;border-top:1px solid rgba(127,127,127,.2);vertical-align:top}
.sentry-health .sh-log{max-height:340px;overflow:auto;font:12px/1.5 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;border:1px solid rgba(127,127,127,.3);border-radius:7px;padding:6px 8px}
.sentry-health .sh-log div{white-space:pre-wrap;overflow-wrap:anywhere}
.sentry-health .sh-log .warn{color:#d69e2e}.sentry-health .sh-log .error{color:#e05252}
`;

const esc = (t) => String(t ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const H = { 'Content-Type': 'application/json', 'X-Requested-With': 'sentry-six-manager' };
async function api(url, opts = {}) {
  const r = await fetch(url, { credentials: 'same-origin', ...opts, headers: { ...H, ...(opts.headers || {}) } });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error || `That did not work (${r.status}).`);
  return d;
}
const size = (b) => (b >= 1024 ** 3 ? `${(b / 1024 ** 3).toFixed(1)} GB` : b >= 1024 ** 2 ? `${(b / 1024 ** 2).toFixed(1)} MB` : `${Math.round((b || 0) / 1024)} KB`);
const day = (d) => { try { return new Date(`${d}T12:00:00`).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' }); } catch { return d; } };
const iso = (t) => new Date(t).toISOString().slice(0, 10);

export function createHealthPage(el) {
  if (!document.getElementById('sentry-health-css')) {
    const style = document.createElement('style');
    style.id = 'sentry-health-css';
    style.textContent = CSS;
    document.head.appendChild(style);
  }
  const today = iso(Date.now());
  const weekAgo = iso(Date.now() - 6 * 86400000);
  el.innerHTML = `<div class="sentry-health">
    <section aria-labelledby="sh-c"><div class="sh-row"><h2 id="sh-c">Checks</h2><button type="button" class="sh-btn" data-run>Run the checks</button><span class="sh-muted" data-when></span></div>
      <p class="sh-muted" style="margin:0">They also run by themselves a minute after every start; what fails there shows as a bar at the top of every page.</p>
      <div data-checks><p class="sh-muted">Loading…</p></div></section>
    <section aria-labelledby="sh-s"><div class="sh-row"><h2 id="sh-s">Database snapshots</h2><button type="button" class="sh-btn" data-snap>Make one now</button></div>
      <p class="sh-muted" style="margin:0">A copy of the accounts, vehicles, settings, policies and starred moments, made every day; the newest 7 are kept in data/snapshots. Restoring one restarts the app; footage is not touched.</p>
      <div data-snaps></div></section>
    <section aria-labelledby="sh-l"><h2 id="sh-l">Logs</h2>
      <form class="sh-row" data-logform>
        <label class="sh-row">From <input type="date" name="from" value="${weekAgo}"></label>
        <label class="sh-row">to <input type="date" name="to" value="${today}"></label>
        <input type="search" name="q" placeholder="Containing…" aria-label="Containing this text" style="flex:1 1 160px">
        <select name="level" aria-label="Which lines"><option value="info">Everything</option><option value="warn">Warnings and errors</option><option value="error">Errors only</option></select>
        <button type="submit" class="sh-btn">Search</button><a class="sh-btn" data-dl href="#">Download these</a>
      </form>
      <div class="sh-log" data-log hidden></div>
      <div class="sh-row"><a class="sh-btn" href="/api/support-bundle" download>Download a support bundle</a>
        <span class="sh-muted">Logs of the last 7 days, these checks and the set-up, with footage paths, share and vehicle names, IP addresses and e-mail addresses replaced and passwords masked.</span></div>
    </section></div>`;
  const $ = (s) => el.querySelector(s);
  let alive = true;

  function drawChecks(res) {
    if (!alive) return;
    $('[data-when]').textContent = res?.at ? `last run ${new Date(res.at).toLocaleString()}` : '';
    const groups = new Map();
    for (const c of res?.checks || []) (groups.get(c.group) || groups.set(c.group, []).get(c.group)).push(c);
    const word = { ok: 'OK', warn: 'CHECK', bad: 'FAIL', skip: 'SKIP' };
    $('[data-checks]').innerHTML = [...groups].map(([g, list]) => `<div class="sh-group">${esc(g)}</div>${list.map((c) => `<div class="sh-check">
      <span class="sh-chip sh-${esc(c.status)}">${word[c.status] || esc(c.status)}</span><b>${esc(c.label)}</b>
      ${c.detail ? `<span class="sh-detail">${esc(c.detail)}</span>` : ''}${c.hint ? `<span class="sh-hint">${esc(c.hint)}</span>` : ''}</div>`).join('')}`).join('') || '<p class="sh-muted">No results yet.</p>';
  }
  async function runChecks(fresh) {
    const b = $('[data-run]');
    b.disabled = true;
    b.textContent = 'Checking…';
    try { drawChecks(await api(fresh ? '/api/health/run' : '/api/health', fresh ? { method: 'POST' } : {})); } catch (err) { $('[data-checks]').innerHTML = `<p>${esc(err.message)}</p>`; }
    b.disabled = false;
    b.textContent = 'Run the checks';
  }

  function drawSnaps(list) {
    if (!alive) return;
    $('[data-snaps]').innerHTML = list.length ? `<table>${list.map((x) => `<tr><td>${esc(day(x.day))}</td><td class="sh-muted">${esc(size(x.bytes))}</td>
      <td style="text-align:right"><button type="button" class="sh-btn" data-restore="${esc(x.name)}">Restore…</button></td></tr>`).join('')}</table>
      <form class="sh-row" data-confirm hidden><span data-what></span><input type="password" name="password" autocomplete="current-password" placeholder="Your password" aria-label="Your password" required>
        <button type="submit" class="sh-btn">Restore and restart</button><button type="button" class="sh-btn" data-cancel>Cancel</button></form>`
      : '<p class="sh-muted">None yet: the first is made a minute after the app starts.</p>';
  }
  const loadSnaps = () => api('/api/snapshots').then((d) => drawSnaps(d.snapshots)).catch((err) => { $('[data-snaps]').innerHTML = `<p>${esc(err.message)}</p>`; });

  function logQuery(download) {
    const f = new FormData($('[data-logform]'));
    const q = new URLSearchParams({ from: f.get('from') || '', to: f.get('to') || '', q: f.get('q') || '', level: f.get('level') || 'info' });
    if (download) q.set('download', '1');
    return `/api/logs/search?${q}`;
  }
  async function searchLogs() {
    const box = $('[data-log]');
    box.hidden = false;
    box.textContent = 'Searching…';
    try {
      const { lines } = await api(logQuery(false));
      box.innerHTML = lines.length ? lines.slice(0, 500).map((l) => `<div class="${esc(l.level)}">${esc(new Date(l.at).toLocaleString())} ${esc(l.level.toUpperCase())} [${esc(l.scope)}] ${esc(l.message)}</div>`).join('')
        + (lines.length > 500 ? `<div class="sh-muted">… ${lines.length - 500} more: download them.</div>` : '') : '<div class="sh-muted">No lines match.</div>';
    } catch (err) { box.textContent = err.message; }
  }

  el.addEventListener('click', async (e) => {
    if (e.target.closest('[data-run]')) { runChecks(true); return; }
    if (e.target.closest('[data-snap]')) {
      try { drawSnaps((await api('/api/snapshots', { method: 'POST' })).snapshots); } catch (err) { alert(err.message); }
      return;
    }
    const r = e.target.closest('[data-restore]');
    if (r) {
      const form = $('[data-confirm]');
      form.hidden = false;
      form.dataset.name = r.dataset.restore;
      form.querySelector('[data-what]').textContent = `Restore ${r.dataset.restore.slice(8, 18)}? Changes since then (accounts, settings, stars) are lost.`;
      form.querySelector('input').focus();
      return;
    }
    if (e.target.closest('[data-cancel]')) { $('[data-confirm]').hidden = true; return; }
    if (e.target.closest('[data-dl]')) { e.preventDefault(); location.href = logQuery(true); }
  });
  el.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (e.target.matches('[data-logform]')) { searchLogs(); return; }
    if (e.target.matches('[data-confirm]')) {
      const form = e.target;
      try {
        await api('/api/auth/confirm', { method: 'POST', body: JSON.stringify({ password: form.password.value }) });
        await api(`/api/snapshots/${encodeURIComponent(form.dataset.name)}/restore`, { method: 'POST' });
        form.innerHTML = '<b>Restoring: the app restarts and this page reloads in about 15 seconds.</b>';
        setTimeout(() => location.reload(), 15000);
      } catch (err) {
        form.password.setCustomValidity(err.message);
        form.password.reportValidity();
        setTimeout(() => form.password.setCustomValidity(''), 3000);
      }
    }
  });

  runChecks(false);
  loadSnaps();
  return { destroy() { alive = false; el.innerHTML = ''; } };
}
