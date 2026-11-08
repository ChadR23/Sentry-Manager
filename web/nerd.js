// The hidden Nerd settings, the same in every interface: tap the Version (or
// Running) line on the Settings page seven times and a "Nerd" button appears
// next to it (kept in this browser). It opens the CAN Bridge panel: turning
// the uploads from the Screenmate CAN Bridge on or off, its token, and the
// logs received so far (docs/can-bridge-api.md).
//
//   watchNerdUnlock(document.body);   // once, from the interface's main script

const KEY = 'sentry-nerd';
const TAPS = 7;
const H = { 'Content-Type': 'application/json', 'X-Requested-With': 'sentry-six-manager' };
const esc = (t) => String(t ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const size = (b) => (b >= 1024 ** 3 ? `${(b / 1024 ** 3).toFixed(2)} GB` : b >= 1024 ** 2 ? `${(b / 1024 ** 2).toFixed(1)} MB` : `${Math.round((b || 0) / 1024)} KB`);
const unlocked = () => { try { return localStorage.getItem(KEY) === '1'; } catch { return false; } };
const setUnlocked = (on) => { try { if (on) localStorage.setItem(KEY, '1'); else localStorage.removeItem(KEY); } catch { /* this visit only */ } };

const STYLE = `
.sentry-nerd-btn{all:unset;box-sizing:border-box;cursor:pointer;margin-left:8px;padding:1px 8px;border-radius:999px;font:700 11px/1.6 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;letter-spacing:.04em;background:#1f2a1f;color:#7dff8a;border:1px solid #3c6b3f;vertical-align:middle}
.sentry-nerd-btn:focus-visible{outline:2px solid #7dff8a;outline-offset:2px}
.sentry-nerd-bg{position:fixed;inset:0;z-index:2147483000;background:rgba(0,0,0,.6);display:flex;align-items:flex-start;justify-content:center;overflow:auto;padding:24px 16px}
.sentry-nerd{box-sizing:border-box;width:min(820px,100%);background:#0d110d;color:#d6f5d6;border:1px solid #2c4a2e;border-radius:14px;padding:20px;font:14px/1.5 system-ui,sans-serif;box-shadow:0 20px 60px rgba(0,0,0,.5)}
.sentry-nerd h2{margin:0 0 4px;font:700 18px/1.3 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;color:#7dff8a}
.sentry-nerd h3{margin:18px 0 6px;font-size:14px;color:#a8e6ad}
.sentry-nerd p{margin:6px 0}
.sentry-nerd .nd-muted{opacity:.7}
.sentry-nerd .nd-row{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin:8px 0}
.sentry-nerd button.nd-btn{all:unset;box-sizing:border-box;cursor:pointer;padding:6px 12px;border-radius:8px;border:1px solid #3c6b3f;background:#162016;color:#d6f5d6;font-weight:600;font-size:13px}
.sentry-nerd button.nd-btn:hover{background:#1e2e1e}
.sentry-nerd button.nd-btn:focus-visible{outline:2px solid #7dff8a;outline-offset:2px}
.sentry-nerd button.nd-btn.nd-danger{border-color:#7a3434;color:#ffb3b3}
.sentry-nerd code,.sentry-nerd .nd-mono{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12.5px;word-break:break-all}
.sentry-nerd .nd-box{background:#070a07;border:1px solid #2c4a2e;border-radius:8px;padding:10px;margin:6px 0}
.sentry-nerd .nd-warn{color:#ffd37a}
.sentry-nerd .nd-scroll{overflow-x:auto}
.sentry-nerd table{border-collapse:collapse;width:100%;font-size:12.5px}
.sentry-nerd th,.sentry-nerd td{text-align:left;padding:5px 8px;border-top:1px solid #1f331f;white-space:nowrap}
.sentry-nerd th{color:#a8e6ad;font-weight:600}
.sentry-nerd .nd-head{display:flex;justify-content:space-between;gap:12px;align-items:flex-start}
.sentry-nerd input.nd-in,.sentry-nerd select.nd-in{color-scheme:dark;box-sizing:border-box;padding:6px 8px;border-radius:8px;border:1px solid #3c6b3f;background:#070a07;color:#d6f5d6;font:13px system-ui,sans-serif;min-width:0}
.sentry-nerd input.nd-in:focus-visible,.sentry-nerd select.nd-in:focus-visible{outline:2px solid #7dff8a;outline-offset:1px}
.sentry-nerd label.nd-lab{display:flex;flex-direction:column;gap:2px;font-size:12px;color:#a8e6ad}
.sentry-nerd .nd-grow{flex:1 1 220px}
.sentry-nerd a.nd-link{color:#7dff8a}
@media (max-width:560px){.sentry-nerd{padding:14px}.sentry-nerd .nd-grow{flex-basis:100%}}
`;

async function api(url, opts = {}) {
  const r = await fetch(url, { credentials: 'same-origin', ...opts, headers: { ...H, ...(opts.headers || {}) } });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(d.error || `That did not work (${r.status}).`), { status: r.status });
  return d;
}

function css() {
  if (document.getElementById('sentry-nerd-css')) return;
  const s = document.createElement('style');
  s.id = 'sentry-nerd-css';
  s.textContent = STYLE;
  document.head.appendChild(s);
}

const OPS = [['>', 'is above'], ['<', 'is below'], ['>=', 'is at least'], ['<=', 'is at most'], ['=', 'is'], ['!=', 'is not'], ['changed', 'changed'], ['appeared', 'first has data']];
const fmtVal = (m) => (m.text ? `${m.text} (${m.value})` : String(m.value));

/**
 * A link that opens the Viewer at a match's moment, or why not. Each
 * interface takes a moment as <clip>~<second>, at its own address: Aurora
 * #/viewer/<car>/day/<day>?at=…, Daylight #/viewer/<car>?day=…&at=…, the
 * others (the built-in one too) #/viewer?day=…&at=….
 */
function openLink(m, vid, pack) {
  const f = m.footage;
  if (!f) return '<span class="nd-muted">no footage</span>';
  const at = encodeURIComponent(`${f.clip}~${f.second}`);
  const car = encodeURIComponent(vid);
  const day = encodeURIComponent(f.day);
  const href = pack === 'aurora' ? `#/viewer/${car}/day/${day}?at=${at}`
    : pack === 'daylight' ? `#/viewer/${car}?day=${day}&at=${at}`
      : `#/viewer?day=${day}&at=${at}&vehicle=${car}`;
  return `<a class="nd-link" data-open href="/${esc(href)}">Open in Viewer</a>`;
}

/**
 * "Find when it started": the first time a CAN signal met a condition, over
 * every indexed minute of a car, and which CAN ids are new or went quiet.
 * Viewer accounts may use it too.
 */
async function drawFind(el, close) {
  let cars = [];
  try { cars = (await api('/api/vehicles')).vehicles || []; } catch { return; }
  let pack = null; // the interface, for the Viewer's address
  try { pack = (await api('/api/ui-packs')).active || null; } catch { /* the built-in one's */ }
  if (!cars.length) return;
  let vid = cars[0].id;
  el.innerHTML = `
    <h3>Find when it started</h3>
    <p class="nd-muted">Every decoded minute of the car, oldest first: the first time a signal met the condition, and the next times after it.</p>
    <form data-sig-form>
      <div class="nd-row">
        ${cars.length > 1 ? `<label class="nd-lab">Car<select class="nd-in" data-car>${cars.map((v) => `<option value="${esc(v.id)}">${esc(v.name)}</option>`).join('')}</select></label>` : ''}
        <label class="nd-lab nd-grow">Signal<input class="nd-in" data-signal list="nd-signals" required autocomplete="off" spellcheck="false" placeholder="Type to search, e.g. DI_vehicleSpeed"></label>
        <datalist id="nd-signals"></datalist>
        <label class="nd-lab">Condition<select class="nd-in" data-op>${OPS.map(([v, t]) => `<option value="${esc(v)}">${esc(t)}</option>`).join('')}</select></label>
        <label class="nd-lab" data-value-wrap>Value<input class="nd-in" data-value size="8" placeholder="40 or a name"></label>
      </div>
      <div class="nd-row">
        <label class="nd-lab">From (optional)<input class="nd-in" type="date" data-from></label>
        <label class="nd-lab">To (optional)<input class="nd-in" type="date" data-to></label>
        <label class="nd-lab" style="flex-direction:row;align-items:center;gap:6px"><input type="checkbox" data-all> Count every match (reads it all)</label>
        <button type="submit" class="nd-btn">Search</button>
      </div>
    </form>
    <div data-sig-out></div>
    <h3>CAN id changes</h3>
    <p class="nd-muted">From the frames counted per minute: ids that are new (since a date, as after a software update; else after the first hour of data), and ids the car sent all the time that went quiet while it was awake.</p>
    <form data-id-form><div class="nd-row">
      <label class="nd-lab">New since (optional)<input class="nd-in" type="date" data-before></label>
      <label class="nd-lab">Quiet for (minutes awake)<input class="nd-in" type="number" min="1" max="10000" value="10" data-gap style="width:7em"></label>
      <button type="submit" class="nd-btn">ID changes</button>
    </div></form>
    <div data-id-out></div>`;
  const $ = (s) => el.querySelector(s);
  const meta = {};
  async function loadSignals() {
    $('#nd-signals').innerHTML = '';
    try {
      const { signals } = await api(`/api/can/vehicle-signals?vehicle=${encodeURIComponent(vid)}`);
      Object.assign(meta, signals);
      const names = Object.keys(signals).sort();
      $('#nd-signals').innerHTML = names.map((n) => { const s = signals[n] || {}; const l = [s.label && s.label !== n ? s.label : '', s.unit ? `(${s.unit})` : ''].filter(Boolean).join(' '); return `<option value="${esc(n)}"${l ? ` label="${esc(l)}"` : ''}></option>`; }).join('');
      $('[data-signal]').placeholder = names.length ? `Type to search ${names.length} signals` : 'No CAN data for this car yet';
    } catch { /* typed by hand, then */ }
  }
  const syncOp = () => { const op = $('[data-op]').value; $('[data-value-wrap]').hidden = op === 'changed' || op === 'appeared'; };
  syncOp();
  loadSignals();
  $('[data-car]')?.addEventListener('change', (e) => { vid = e.target.value; $('[data-sig-out]').innerHTML = ''; $('[data-id-out]').innerHTML = ''; loadSignals(); });
  $('[data-op]').addEventListener('change', syncOp);
  el.addEventListener('click', (e) => { if (e.target.closest('a[data-open]')) close(); }); // the Viewer, under the panel

  let sigFrom = null; // a scan out of time goes on from here
  async function searchSignal(resume) {
    const out = $('[data-sig-out]');
    const name = $('[data-signal]').value.trim();
    const op = $('[data-op]').value;
    if (!name) return;
    const q = new URLSearchParams({ vehicle: vid, signal: name, op });
    if (!$('[data-value-wrap]').hidden) q.set('value', $('[data-value]').value.trim());
    if (resume && sigFrom) q.set('from', String(sigFrom)); else if ($('[data-from]').value) q.set('from', $('[data-from]').value);
    if ($('[data-to]').value) q.set('to', $('[data-to]').value);
    if ($('[data-all]').checked) q.set('all', '1');
    out.innerHTML = '<p class="nd-muted">Searching… (a long history can take a while)</p>';
    let r;
    try { r = await api(`/api/can/search?${q}`); } catch (err) { out.innerHTML = `<p class="nd-warn">${esc(err.message)}</p>`; return; }
    sigFrom = r.complete ? null : r.resumeFrom;
    const unit = r.unit ? ` ${r.unit}` : '';
    const opText = OPS.find(([v]) => v === op)?.[1] || op;
    const head = r.first
      ? `<p><b>First:</b> ${esc(r.first.localTime)} (car time) · ${esc(fmtVal(r.first))}${esc(unit)}${r.first.previous !== undefined && r.first.previous !== null ? ` (was ${esc(r.first.previousText || r.first.previous)})` : ''} · ${openLink(r.first, vid, pack)}</p>`
      : `<p>${esc(name)} never ${esc(opText)}${r.value !== null && r.value !== undefined && op !== 'changed' && op !== 'appeared' ? ` ${esc(r.value)}${esc(unit)}` : ''} in ${r.scannedMinutes.toLocaleString()} minute${r.scannedMinutes === 1 ? '' : 's'} read${r.minutesWithData ? '' : ' (the signal has no data in them)'}.</p>`;
    const counts = `<p class="nd-muted">${r.matchingMinutes.toLocaleString()} matching minute${r.matchingMinutes === 1 ? '' : 's'} of ${r.minutesWithData.toLocaleString()} with this signal${r.complete ? '' : ' so far'}; ${r.scannedMinutes.toLocaleString()} of ${r.totalMinutes.toLocaleString()} minutes read.</p>`;
    const more = r.resumeFrom && !r.complete && r.scannedMinutes < r.totalMinutes && !r.matches.length
      ? `<div class="nd-row"><button type="button" class="nd-btn" data-resume>Go on reading from ${esc(new Date(r.resumeFrom).toLocaleString())}</button></div>` : '';
    out.innerHTML = `${head}${counts}${r.matches.length > 1 ? `<div class="nd-scroll"><table><thead><tr><th>When (car time)</th><th>Value</th><th></th></tr></thead><tbody>
      ${r.matches.map((m) => `<tr><td>${esc(m.localTime)}</td><td>${esc(fmtVal(m))}${esc(unit)}</td><td>${openLink(m, vid, pack)}</td></tr>`).join('')}</tbody></table></div>` : ''}${more}`;
  }
  $('[data-sig-form]').addEventListener('submit', (e) => { e.preventDefault(); sigFrom = null; searchSignal(false); });
  el.addEventListener('click', (e) => { if (e.target.closest('[data-resume]')) searchSignal(true); });

  $('[data-id-form]').addEventListener('submit', async (e) => {
    e.preventDefault();
    const out = $('[data-id-out]');
    const q = new URLSearchParams({ vehicle: vid, gap: $('[data-gap]').value || '10' });
    if ($('[data-before]').value) q.set('before', $('[data-before]').value);
    out.innerHTML = '<p class="nd-muted">Reading the frame counts…</p>';
    let r;
    try { r = await api(`/api/can/id-events?${q}`); } catch (err) { out.innerHTML = `<p class="nd-warn">${esc(err.message)}</p>`; return; }
    if (!r.totalMinutes) { out.innerHTML = '<p class="nd-muted">No CAN data for this car yet.</p>'; return; }
    const span = `<p class="nd-muted">${r.idCount.toLocaleString()} ids in ${r.awakeMinutes.toLocaleString()} awake minutes${r.complete ? '' : ` (stopped reading at ${esc(new Date(r.resumeFrom).toLocaleString())}: out of time)`}.</p>`;
    const table = (rows, cols) => `<div class="nd-scroll"><table><thead><tr>${cols.map((c) => `<th>${esc(c)}</th>`).join('')}<th></th></tr></thead><tbody>${rows}</tbody></table></div>`;
    out.innerHTML = `${span}
      <p><b>New ids</b>${r.appearedCount > r.appeared.length ? ` (first ${r.appeared.length} of ${r.appearedCount})` : ''}</p>
      ${r.appeared.length ? table(r.appeared.map((x) => `<tr><td class="nd-mono">${esc(x.id)}</td><td>${esc(x.localTime)}</td><td>${x.seenMinutes.toLocaleString()}</td><td>${openLink(x, vid, pack)}</td></tr>`).join(''), ['Id', 'First seen (car time)', 'Minutes seen']) : '<p class="nd-muted">None.</p>'}
      <p><b>Went quiet</b> (for ${esc(r.gap)}+ awake minutes)</p>
      ${r.stopped.length ? table(r.stopped.map((x) => `<tr><td class="nd-mono">${esc(x.id)}</td><td>${esc(x.localTime)}</td><td>${x.back ? `after ${x.missingMinutes.toLocaleString()} min` : `still quiet (${x.missingMinutes.toLocaleString()} min)`}</td><td>${openLink(x, vid, pack)}</td></tr>`).join(''), ['Id', 'Quiet from (car time)', 'Back']) : '<p class="nd-muted">None.</p>'}`;
  });
}

/** The CAN Bridge panel, as a dialog over the page. */
export function openNerdPanel() {
  css();
  const bg = document.createElement('div');
  bg.className = 'sentry-nerd-bg';
  bg.innerHTML = `<div class="sentry-nerd" role="dialog" aria-modal="true" aria-labelledby="nd-title">
    <div class="nd-head"><div><h2 id="nd-title">&gt;_ nerd</h2><p class="nd-muted">CAN Bridge: every CAN message the car sends, recorded by the Screenmate and synced to the footage.</p></div>
      <button type="button" class="nd-btn" data-close aria-label="Close">Close</button></div>
    <div data-body><p class="nd-muted">Loading…</p></div>
    <div data-find></div>
  </div>`;
  const prevFocus = document.activeElement;
  const close = () => { bg.remove(); document.removeEventListener('keydown', onKey, true); prevFocus?.focus?.(); };
  const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } };
  document.addEventListener('keydown', onKey, true);
  bg.addEventListener('click', (e) => { if (e.target === bg || e.target.closest('[data-close]')) close(); });
  document.body.appendChild(bg);
  bg.querySelector('[data-close]').focus();
  const body = bg.querySelector('[data-body]');
  let token = null; // shown once, right after it is made
  let fingerprint = null;

  async function confirmThen(path) {
    try { return await api(path, { method: 'POST' }); } catch (err) {
      if (!/password/i.test(err.message)) { alert(err.message); return null; }
      const pw = prompt('Enter your password to confirm:');
      if (!pw) return null;
      try {
        await api('/api/auth/confirm', { method: 'POST', body: JSON.stringify({ password: pw }) });
        return await api(path, { method: 'POST' });
      } catch (e2) { alert(e2.message); return null; }
    }
  }

  async function draw() {
    let st;
    let files;
    try {
      [st, files] = await Promise.all([api('/api/can/settings'), api('/api/can/files?limit=100')]);
    } catch (err) {
      body.innerHTML = `<p class="nd-warn">${esc(err.status === 403 ? 'Only an admin account can change these.' : err.message)}</p>`;
      return;
    }
    // the CAN Bridge's own port (10000 unless CAN_PORT says otherwise)
    const port = st.port?.port || 10000;
    const url = `${st.port?.https === false ? 'http' : 'https'}://${location.hostname.includes(':') ? `[${location.hostname}]` : location.hostname}:${port}/api/can/logs`;
    const https = location.protocol === 'https:';
    body.innerHTML = `
      <h3>Uploads from the CAN Bridge</h3>
      ${st.enabled
        ? `<p>On since ${esc(new Date(st.since).toLocaleString())}. The app uploads finished logs to:</p>
           <div class="nd-box nd-mono">${esc(url)}</div>
           <p class="${st.port?.listening ? 'nd-muted' : 'nd-warn'}">${st.port?.listening ? `Port ${port} is open for the CAN Bridge (only its uploads; it closes when this is turned off).` : st.port?.error ? `Port ${port} could not open: ${esc(st.port.error)}` : `Port ${port} is opening…`}
             If Sentry Six Manager runs in Docker, the port must also be published (<code>${port}:${port}</code>).</p>
           ${token ? `<p><b>Token</b> (shown once: paste it into the CAN Bridge app now):</p><div class="nd-box nd-mono" data-token>${esc(token)}</div>
             ${fingerprint ? `<p><b>Certificate SHA-256</b> (the app pins it):</p><div class="nd-box nd-mono">${esc(fingerprint)}</div>` : ''}
             <div class="nd-row"><button type="button" class="nd-btn" data-copy>Copy token</button></div>` : '<p class="nd-muted">The token was shown when it was made. Make a new one if the app needs it again (the old one stops working).</p>'}
           <div class="nd-row"><button type="button" class="nd-btn" data-on>New token…</button><button type="button" class="nd-btn nd-danger" data-off>Turn off…</button></div>`
        : `<p>Off: port ${port} is closed, and the upload address answers "not found".</p>
           <div class="nd-row"><button type="button" class="nd-btn" data-on>Turn on…</button></div>`}
      ${https || st.port?.https ? '' : '<p class="nd-warn">This page is on plain HTTP. The app only uploads over HTTPS: open Sentry Six Manager with https:// for the address and the certificate it pins.</p>'}
      <p class="nd-muted">The token can only upload CAN logs: it cannot see footage or change anything else.</p>

      <h3>Received logs</h3>
      <p>${st.logs ? `${st.logs.toLocaleString()} log${st.logs === 1 ? '' : 's'}, ${esc(size(st.bytes))} in all. Kept exactly as recorded, also the messages nothing knows the meaning of yet.` : 'None yet.'}</p>
      ${files.logs.length ? `<div class="nd-scroll"><table><thead><tr><th>Started</th><th>Car</th><th>Size</th><th>Frames</th><th>Dropped</th><th>App</th><th></th></tr></thead><tbody>
        ${files.logs.map((f) => `<tr><td>${esc(new Date(f.startedAt).toLocaleString())}${f.seq ? ` · #${f.seq}` : ''}</td><td class="nd-mono">${esc(f.vehicleKey)}</td><td>${esc(size(f.bytes))}</td>
          <td>${f.frames === null ? '—' : f.frames.toLocaleString()}</td><td>${f.dropped === null ? '—' : f.dropped.toLocaleString()}</td><td class="nd-mono">${esc(f.appVersion || (f.sidecar ? '' : 'no sidecar yet'))}</td>
          <td><button type="button" class="nd-btn nd-danger" data-del="${esc(f.name)}" aria-label="Delete the log ${esc(f.name)}">Delete</button></td></tr>`).join('')}
      </tbody></table></div>` : ''}

      ${st.keys?.length ? `<h3>Which car</h3>
      <p class="nd-muted">The CAN Bridge names each car by a key. ${st.vehicles.length === 1 ? 'With one car here, every key is that car unless you choose.' : 'Choose the car each key is, for the Viewer.'}</p>
      ${st.keys.map((k) => `<div class="nd-row"><span class="nd-mono">${esc(k)}</span><select data-map="${esc(k)}" aria-label="The car ${esc(k)} is" class="nd-btn">
        <option value="">${st.vehicles.length === 1 ? `${esc(st.vehicles[0].name)} (only car)` : 'Not chosen'}</option>
        ${st.vehicles.map((v) => `<option value="${esc(v.id)}"${st.map[k] === v.id ? ' selected' : ''}>${esc(v.name)}</option>`).join('')}</select></div>`).join('')}` : ''}

      <h3>Index</h3>
      <p>${st.index.running ? `Decoding${st.index.current ? ` <span class="nd-mono">${esc(st.index.current)}</span>` : ''}… ${st.index.pending ? `${st.index.pending} log${st.index.pending === 1 ? '' : 's'} to go.` : ''}` : 'Every log is decoded and ready for the Viewer.'}
        ${st.index.lastError ? `<br><span class="nd-warn">Last problem: ${esc(st.index.lastError)}</span>` : ''}</p>
      <p class="nd-muted">Each log is decoded once when it arrives (Model 3/Y DBC, model3dbc), into signals per minute, so the Viewer's dashboard has them at once: Customize, then pick any signal under "CAN".</p>
      <div class="nd-row"><button type="button" class="nd-btn" data-hide>Hide the Nerd button</button></div>`;
  }

  body.addEventListener('change', async (e) => {
    const sel = e.target.closest('[data-map]');
    if (!sel) return;
    try { await api('/api/can/vehicle-map', { method: 'POST', body: JSON.stringify({ key: sel.dataset.map, vehicleId: sel.value || null }) }); } catch (err) { alert(err.message); }
  });
  body.addEventListener('click', async (e) => {
    if (e.target.closest('[data-on]')) {
      const d = await confirmThen('/api/can/enable');
      if (d) { token = d.token; fingerprint = d.fingerprint; await draw(); }
    } else if (e.target.closest('[data-off]')) {
      if (!confirm('Turn CAN Bridge uploads off? The logs already here are kept; the token stops working.')) return;
      if (await confirmThen('/api/can/disable')) { token = null; await draw(); }
    } else if (e.target.closest('[data-copy]')) {
      try { await navigator.clipboard.writeText(token); e.target.textContent = 'Copied'; } catch { /* select it by hand */ }
    } else if (e.target.closest('[data-del]')) {
      const name = e.target.closest('[data-del]').dataset.del;
      if (!confirm(`Delete ${name}? It cannot be brought back.`)) return;
      try { await api(`/api/can/files/${encodeURIComponent(name)}`, { method: 'DELETE' }); } catch (err) { alert(err.message); }
      await draw();
    } else if (e.target.closest('[data-hide]')) {
      setUnlocked(false);
      document.querySelectorAll('.sentry-nerd-btn').forEach((b) => b.remove());
      close();
    }
  });
  draw();
  drawFind(bg.querySelector('[data-find]'), close);
  return { close };
}

/**
 * Tap the Version line seven times (within a few seconds) on any Settings
 * page and the Nerd button appears beside it; once unlocked it stays in this
 * browser. Watches for pages drawn later.
 */
export function watchNerdUnlock(root = document.body) {
  css();
  const LABEL = /^(version|running)$/i;
  const addButton = (dd) => {
    if (dd.querySelector('.sentry-nerd-btn')) return;
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'sentry-nerd-btn';
    b.textContent = '>_ nerd';
    b.title = 'CAN Bridge: the car\'s CAN bus, synced to the footage';
    b.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); openNerdPanel(); });
    dd.appendChild(b);
  };
  const arm = () => {
    for (const dt of root.querySelectorAll('dt:not([data-nerd])')) {
      if (!LABEL.test(dt.textContent.trim())) continue;
      const dd = dt.nextElementSibling;
      if (!dd || dd.tagName !== 'DD') continue;
      dt.setAttribute('data-nerd', '');
      if (unlocked()) { addButton(dd); continue; }
      let taps = [];
      const tap = () => {
        const t = Date.now();
        taps = [...taps.filter((x) => t - x < 4000), t];
        if (taps.length < TAPS || unlocked()) return;
        setUnlocked(true);
        addButton(dd);
        dd.querySelector('.sentry-nerd-btn')?.focus();
      };
      dt.addEventListener('click', tap);
      dd.addEventListener('click', tap);
    }
  };
  arm();
  let queued = false;
  new MutationObserver((list) => {
    if (queued || !list.some((m) => [...m.addedNodes].some((n) => n.nodeType === 1))) return;
    queued = true;
    requestAnimationFrame(() => { queued = false; arm(); });
  }).observe(root, { childList: true, subtree: true });
}
