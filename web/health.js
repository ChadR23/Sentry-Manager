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
// a day on this device's calendar (the server reads From and To as local days too)
const iso = (t) => { const d = new Date(t); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };

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
    <section aria-labelledby="sh-f"><div class="sh-row"><h2 id="sh-f">Footage check</h2></div>
      <p class="sh-muted" style="margin:0">Finds clips that will not play: cut off when the car lost power, empty, or not video at all. Only a few bytes of each file are read; a check that a restart interrupts goes on where it was, and unchanged files are not read again.</p>
      <div data-integrity><p class="sh-muted">Loading…</p></div></section>
    <section aria-labelledby="sh-r"><h2 id="sh-r">Which alerts you get</h2>
      <p class="sh-muted" style="margin:0">Turn a kind off and it no longer makes a notification (it is still in the logs). The critical-update bar always shows.</p>
      <div data-rules class="sh-row"></div></section>
    <section aria-labelledby="sh-m"><h2 id="sh-m">Metrics for your own monitoring</h2>
      <p class="sh-muted" style="margin:0">For Prometheus, Grafana or Home Assistant on your network: free space, footage size, shares up or down, conversions, open alerts. <b>Off unless you turn it on</b>; then <code>/metrics</code> on this same address answers only with the token made here (read-only numbers, no paths or names). No new port is opened.</p>
      <div data-metrics></div></section>
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

  // ---- footage check, per vehicle
  let vehicles = [];
  const polls = new Map();
  async function drawIntegrity() {
    if (!alive) return;
    const rows = await Promise.all(vehicles.map(async (v) => {
      let r = null;
      try { r = await api(`/api/vehicles/${encodeURIComponent(v.id)}/integrity`); } catch { /* shown as unknown */ }
      return { v, r };
    }));
    if (!alive) return;
    $('[data-integrity]').innerHTML = rows.map(({ v, r }) => {
      const busy = r?.running;
      const state = !r ? 'Could not be read.' : busy ? `Checking: ${r.done} of ${r.total} files…`
        : r.checked ? `${r.checked} of ${r.files} files checked${r.checked < r.files ? ' (new files since: check again)' : ''}: ${r.problems.length + (r.more || 0) ? `<b>${r.problems.length + (r.more || 0)} will not play</b>` : 'all fine'}` : 'Not checked yet.';
      const list = r?.problems?.length ? `<table>${r.problems.slice(0, 100).map((p) => `<tr><td>${esc(p.day || '')}</td><td>${esc(p.rel.split('/').pop())}</td><td class="sh-muted">${esc(p.problem)}</td></tr>`).join('')}</table>${r.problems.length > 100 || r.more ? '<p class="sh-muted">… and more: download the logs or the support bundle for the full list.</p>' : ''}` : '';
      if (busy && !polls.has(v.id)) polls.set(v.id, setTimeout(() => { polls.delete(v.id); drawIntegrity(); }, 2000));
      return `<div class="sh-group">${esc(v.name)}</div><div class="sh-row"><span>${state}</span><button type="button" class="sh-btn" data-check="${esc(v.id)}"${busy ? ' disabled' : ''}>${r?.checked ? 'Check again' : 'Check now'}</button></div>${list}`;
    }).join('') || '<p class="sh-muted">No vehicles yet.</p>';
  }
  el.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-check]');
    if (!b) return;
    b.disabled = true;
    try { await api(`/api/vehicles/${encodeURIComponent(b.dataset.check)}/integrity`, { method: 'POST' }); } catch (err) { alert(err.message); }
    drawIntegrity();
  });
  api('/api/vehicles').then((d) => { vehicles = d.vehicles || []; drawIntegrity(); }).catch(() => { $('[data-integrity]').innerHTML = '<p class="sh-muted">Could not load the vehicles.</p>'; });

  // ---- notification rules
  const RULES = { share: 'Footage share offline or read-only', storage: 'Share running out of space', server: 'Server hardware (temperatures, disks, memory)', health: 'Startup check failures', conversion: 'Conversions that fail', update: 'New versions' };
  async function drawRules() {
    let d;
    try { d = await api('/api/notification-rules'); } catch (err) { $('[data-rules]').textContent = err.message; return; }
    if (!alive) return;
    $('[data-rules]').innerHTML = d.rules.map((r) => `<label class="sh-row" style="flex:1 1 260px"><input type="checkbox" data-rule="${esc(r.kind)}"${r.on ? ' checked' : ''}> ${esc(RULES[r.kind] || r.kind)}</label>`).join('');
  }
  el.addEventListener('change', async (e) => {
    if (!e.target.matches('[data-rule]')) return;
    const rules = Object.fromEntries([...el.querySelectorAll('[data-rule]')].map((x) => [x.dataset.rule, x.checked]));
    try { await api('/api/notification-rules', { method: 'PUT', body: JSON.stringify({ rules }) }); } catch (err) { alert(err.message); drawRules(); }
  });

  // ---- metrics (opt-in)
  async function drawMetrics(token = null) {
    let d;
    try { d = await api('/api/metrics/settings'); } catch (err) { $('[data-metrics]').textContent = err.message; return; }
    if (!alive) return;
    const url = `${location.origin}/metrics`;
    $('[data-metrics]').innerHTML = d.enabled
      ? `<p><b>On.</b> ${token ? `Your token (shown once; keep it like a password):<br><code style="user-select:all">${esc(token)}</code></p>
          <p class="sh-muted">Prometheus:</p><pre class="sh-log" style="max-height:none">- job_name: sentry-six-manager\n  scheme: ${esc(location.protocol.replace(':', ''))}\n  static_configs: [{ targets: ['${esc(location.host)}'] }]\n  authorization: { credentials: '${esc(token)}' }${location.protocol === 'https:' ? '\n  tls_config: { insecure_skip_verify: true }  # or the CA from Settings → Security' : ''}</pre>`
        : `Scraped at <code>${esc(url)}</code> with the token made when it was turned on.</p>`}
        <div class="sh-row"><button type="button" class="sh-btn" data-metrics-on>New token</button><button type="button" class="sh-btn" data-metrics-off>Turn off</button></div>`
      : '<p class="sh-muted">Off.</p><div class="sh-row"><button type="button" class="sh-btn" data-metrics-on>Turn on…</button></div>';
  }
  async function metricsAction(path) {
    try { return await api(path, { method: 'POST' }); } catch (err) {
      if (/password/i.test(err.message)) {
        const pw = prompt('Enter your password to confirm:');
        if (!pw) return null;
        try { await api('/api/auth/confirm', { method: 'POST', body: JSON.stringify({ password: pw }) }); return await api(path, { method: 'POST' }); } catch (e2) { alert(e2.message); return null; }
      }
      alert(err.message);
      return null;
    }
  }
  el.addEventListener('click', async (e) => {
    if (e.target.closest('[data-metrics-on]')) { const d = await metricsAction('/api/metrics/enable'); if (d) drawMetrics(d.token); }
    if (e.target.closest('[data-metrics-off]')) { if (await metricsAction('/api/metrics/disable')) drawMetrics(); }
  });
  drawRules();
  drawMetrics();

  runChecks(false);
  loadSnaps();
  return { destroy() { alive = false; for (const t of polls.values()) clearTimeout(t); el.innerHTML = ''; } };
}
