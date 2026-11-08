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
.sentry-nerd .nd-ok{color:#7dff8a;font-weight:700}
.sentry-nerd .nd-bad{color:#ff8a8a;font-weight:700}
.sentry-nerd .nd-box ul{margin:4px 0;padding-left:18px}
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

// where each interface keeps the car picked in it (in this browser) ...
const PICKED = { '': 'sm:vehicle', aurora: 'aurora:vehicle', daylight: 'daylight:vehicle', flux: 'flux:vehicle', horizon: 'horizon.vehicle' };
// ... and the ones whose Viewer plays that car, whatever a link says
const PICKS_OWN = new Set(['flux', 'horizon']);

/** The interface this browser shows: null for the built-in one (also when this browser chose it over the active pack). */
export const packOf = (ui) => (ui?.original ? null : ui?.active || null);

/** The car picked in the interface (as it keeps it), else the first. */
export function pickedCar(pack, cars, storage = globalThis.localStorage) {
  let id = null;
  try { id = JSON.parse(storage.getItem(PICKED[pack || '']) ?? 'null'); } catch { /* none kept */ }
  return cars.some((v) => v.id === id) ? id : cars[0]?.id ?? null;
}

/** Only the newest request's answer is shown: next() before asking, stale(n) after; drop() makes every open one stale. */
export function latest() {
  let n = 0;
  return { next: () => ++n, stale: (t) => t !== n, drop: () => { n++; } };
}

/**
 * A link that opens the Viewer at a match's moment, or why not. Each
 * interface takes a moment as <clip>~<second>, at its own address: Aurora
 * #/viewer/<car>/day/<day>?at=…, Daylight #/viewer/<car>?day=…&at=…, the
 * others (the built-in one too) #/viewer?day=…&at=…&vehicle=…. Flux and
 * Horizon play the car picked in them whatever the link says, so for another
 * car (`picked` is the one picked there) the link would open the wrong footage.
 */
export function openLink(m, vid, pack, picked = null) {
  const f = m.footage;
  if (!f) return '<span class="nd-muted">no footage</span>';
  if (PICKS_OWN.has(pack) && picked && picked !== vid) return '<span class="nd-muted">pick this car in the interface to open it</span>';
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
  try { pack = packOf(await api('/api/ui-packs')); } catch { /* the built-in one's */ }
  if (!cars.length) return;
  const picked = pickedCar(pack, cars); // the car picked in the interface: searched first
  let vid = picked;
  el.innerHTML = `
    <h3>Find when it started</h3>
    <p class="nd-muted">Every decoded minute of the car, oldest first: the first time a signal met the condition, and the next times after it.</p>
    <form data-sig-form>
      <div class="nd-row">
        ${cars.length > 1 ? `<label class="nd-lab">Car<select class="nd-in" data-car>${cars.map((v) => `<option value="${esc(v.id)}"${v.id === vid ? ' selected' : ''}>${esc(v.name)}</option>`).join('')}</select></label>` : ''}
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
  // one guard each: an answer that comes after a newer request (or another car) is dropped
  const sigAsk = latest();
  const idAsk = latest();
  const listAsk = latest();
  async function loadSignals() {
    const n = listAsk.next();
    const car = vid;
    $('#nd-signals').innerHTML = '';
    try {
      const { signals } = await api(`/api/can/vehicle-signals?vehicle=${encodeURIComponent(car)}`);
      if (listAsk.stale(n)) return;
      Object.assign(meta, signals);
      const names = Object.keys(signals).sort();
      $('#nd-signals').innerHTML = names.map((n) => { const s = signals[n] || {}; const l = [s.label && s.label !== n ? s.label : '', s.unit ? `(${s.unit})` : ''].filter(Boolean).join(' '); return `<option value="${esc(n)}"${l ? ` label="${esc(l)}"` : ''}></option>`; }).join('');
      $('[data-signal]').placeholder = names.length ? `Type to search ${names.length} signals` : 'No CAN data for this car yet';
    } catch { /* typed by hand, then */ }
  }
  const syncOp = () => { const op = $('[data-op]').value; $('[data-value-wrap]').hidden = op === 'changed' || op === 'appeared'; };
  syncOp();
  loadSignals();
  $('[data-car]')?.addEventListener('change', (e) => {
    vid = e.target.value;
    sigAsk.drop();
    idAsk.drop();
    sigResume = null;
    idResume = null;
    $('[data-sig-out]').innerHTML = '';
    $('[data-id-out]').innerHTML = '';
    loadSignals();
  });
  $('[data-op]').addEventListener('change', syncOp);
  el.addEventListener('click', (e) => { if (e.target.closest('a[data-open]')) close(); }); // the Viewer, under the panel
  const goOn = (r, attr) => (r.resume
    ? `<div class="nd-row"><button type="button" class="nd-btn" ${attr}>Go on reading from ${esc(new Date(r.resumeFrom).toLocaleString())}</button></div>` : '');

  // a scan out of time: its token, to go on exactly where it stopped (with what it found so far)
  let sigResume = null;
  async function searchSignal(resume) {
    const out = $('[data-sig-out]');
    const car = vid;
    let q;
    if (resume && sigResume) q = new URLSearchParams({ vehicle: car, resume: sigResume });
    else {
      const name = $('[data-signal]').value.trim();
      if (!name) return;
      q = new URLSearchParams({ vehicle: car, signal: name, op: $('[data-op]').value });
      if (!$('[data-value-wrap]').hidden) q.set('value', $('[data-value]').value.trim());
      if ($('[data-from]').value) q.set('from', $('[data-from]').value);
      if ($('[data-to]').value) q.set('to', $('[data-to]').value);
      if ($('[data-all]').checked) q.set('all', '1');
    }
    const n = sigAsk.next();
    out.innerHTML = '<p class="nd-muted">Searching… (a long history can take a while)</p>';
    let r;
    try { r = await api(`/api/can/search?${q}`); } catch (err) { if (!sigAsk.stale(n)) out.innerHTML = `<p class="nd-warn">${esc(err.message)}</p>`; return; }
    if (sigAsk.stale(n)) return;
    sigResume = r.resume || null;
    const { op, signal: name } = r;
    const unit = r.unit ? ` ${r.unit}` : '';
    const opText = OPS.find(([v]) => v === op)?.[1] || op;
    const head = r.first
      ? `<p><b>First:</b> ${esc(r.first.localTime)} (car time) · ${esc(fmtVal(r.first))}${esc(unit)}${r.first.previous !== undefined && r.first.previous !== null ? ` (was ${esc(r.first.previousText || r.first.previous)})` : ''} · ${openLink(r.first, car, pack, picked)}</p>`
      : `<p>${esc(name)} never ${esc(opText)}${r.value !== null && r.value !== undefined && op !== 'changed' && op !== 'appeared' ? ` ${esc(r.value)}${esc(unit)}` : ''} in ${r.scannedMinutes.toLocaleString()} minute${r.scannedMinutes === 1 ? '' : 's'} read${r.minutesWithData ? '' : ' (the signal has no data in them)'}.</p>`;
    const counts = `<p class="nd-muted">${r.matchingMinutes.toLocaleString()} matching minute${r.matchingMinutes === 1 ? '' : 's'} of ${r.minutesWithData.toLocaleString()} with this signal${r.complete ? '' : ' so far'}; ${r.scannedMinutes.toLocaleString()} of ${r.totalMinutes.toLocaleString()} minutes read.</p>`;
    out.innerHTML = `${head}${counts}${r.matches.length > 1 ? `<div class="nd-scroll"><table><thead><tr><th>When (car time)</th><th>Value</th><th></th></tr></thead><tbody>
      ${r.matches.map((m) => `<tr><td>${esc(m.localTime)}</td><td>${esc(fmtVal(m))}${esc(unit)}</td><td>${openLink(m, car, pack, picked)}</td></tr>`).join('')}</tbody></table></div>` : ''}${goOn(r, 'data-resume')}`;
  }
  $('[data-sig-form]').addEventListener('submit', (e) => { e.preventDefault(); sigResume = null; searchSignal(false); });
  el.addEventListener('click', (e) => { if (e.target.closest('[data-resume]')) searchSignal(true); });

  let idResume = null;
  async function searchIds(resume) {
    const out = $('[data-id-out]');
    const car = vid;
    const q = new URLSearchParams({ vehicle: car });
    if (resume && idResume) q.set('resume', idResume);
    else {
      q.set('gap', $('[data-gap]').value || '10');
      if ($('[data-before]').value) q.set('before', $('[data-before]').value);
    }
    const n = idAsk.next();
    out.innerHTML = '<p class="nd-muted">Reading the frame counts…</p>';
    let r;
    try { r = await api(`/api/can/id-events?${q}`); } catch (err) { if (!idAsk.stale(n)) out.innerHTML = `<p class="nd-warn">${esc(err.message)}</p>`; return; }
    if (idAsk.stale(n)) return;
    idResume = r.resume || null;
    if (!r.totalMinutes) { out.innerHTML = '<p class="nd-muted">No CAN data for this car yet.</p>'; return; }
    const span = `<p class="nd-muted">${r.idCount.toLocaleString()} ids in ${r.awakeMinutes.toLocaleString()} awake minutes${r.complete ? '' : `, ${r.scannedMinutes.toLocaleString()} of ${r.totalMinutes.toLocaleString()} minutes read (out of time)`}.</p>`;
    // not all read: what is not there yet may still come
    const none = r.complete ? '<p class="nd-muted">None.</p>' : '<p class="nd-muted">None so far (not all of it read yet).</p>';
    const table = (rows, cols) => `<div class="nd-scroll"><table><thead><tr>${cols.map((c) => `<th>${esc(c)}</th>`).join('')}<th></th></tr></thead><tbody>${rows}</tbody></table></div>`;
    out.innerHTML = `${span}${goOn(r, 'data-id-resume')}
      <p><b>New ids</b>${r.appearedCount > r.appeared.length ? ` (first ${r.appeared.length} of ${r.appearedCount})` : ''}</p>
      ${r.appeared.length ? table(r.appeared.map((x) => `<tr><td class="nd-mono">${esc(x.id)}</td><td>${esc(x.localTime)}</td><td>${x.seenMinutes.toLocaleString()}</td><td>${openLink(x, car, pack, picked)}</td></tr>`).join(''), ['Id', 'First seen (car time)', 'Minutes seen']) : none}
      <p><b>Went quiet</b> (for ${esc(r.gap)}+ awake minutes)</p>
      ${r.stopped.length ? table(r.stopped.map((x) => `<tr><td class="nd-mono">${esc(x.id)}</td><td>${esc(x.localTime)}</td><td>${x.back ? `after ${x.missingMinutes.toLocaleString()} min` : `still quiet (${x.missingMinutes.toLocaleString()} min${r.complete ? '' : ' so far'})`}</td><td>${openLink(x, car, pack, picked)}</td></tr>`).join(''), ['Id', 'Quiet from (car time)', 'Back']) : none}`;
  }
  $('[data-id-form]').addEventListener('submit', (e) => { e.preventDefault(); idResume = null; searchIds(false); });
  el.addEventListener('click', (e) => { if (e.target.closest('[data-id-resume]')) searchIds(true); });
}

/** The CAN Bridge panel, as a dialog over the page. */
/**
 * The upload address for the CAN Bridge app: this page's host on the CAN port.
 * A browser gives an IPv6 host with its brackets already ('[fd00::5]'), so
 * they are added only when missing.
 */
export function canUploadAddress(hostname, port, https = true) {
  const host = hostname.includes(':') && !hostname.startsWith('[') ? `[${hostname}]` : hostname;
  return `${https ? 'https' : 'http'}://${host}:${port}/api/can/logs`;
}

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

  // a change that asks for the password first (the server says so)
  async function confirmThen(path, opts = { method: 'POST' }) {
    try { return await api(path, opts); } catch (err) {
      if (!/password/i.test(err.message)) { alert(err.message); return null; }
      const pw = prompt('Enter your password to confirm:');
      if (!pw) return null;
      try {
        await api('/api/auth/confirm', { method: 'POST', body: JSON.stringify({ password: pw }) });
        return await api(path, opts);
      } catch (e2) { alert(e2.message); return null; }
    }
  }
  const CHECK = {
    verified: ['✓ verified', 'nd-ok', 'Signed by this car\'s paired key, and the file is what was signed.'],
    failed: ['✗ failed', 'nd-bad', ''],
    unsigned: ['unsigned', 'nd-muted', 'No signature (an older CAN Bridge, before pairing). Used, with a note.'],
    waiting: ['waiting', 'nd-muted', 'Its sidecar (with the signature) has not arrived yet.']
  };
  const when = (t) => (t ? new Date(t).toLocaleString() : '—');
  const carName = (st, id) => st.vehicles.find((v) => v.id === id)?.name || (id ? id : 'any car');

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
    const url = canUploadAddress(location.hostname, port, st.port?.https !== false);
    const https = location.protocol === 'https:';
    const trustOf = (k) => st.trust?.find((x) => x.key === k);
    body.innerHTML = `
      <h3>Uploads from the CAN Bridge</h3>
      ${st.enabled
        ? `<p>On since ${esc(when(st.since))}. The app uploads finished logs to:</p>
           <div class="nd-box nd-mono">${esc(url)}</div>
           <p class="${st.port?.listening ? 'nd-muted' : 'nd-warn'}">${st.port?.listening ? `Port ${port} is open for the CAN Bridge (only its uploads; it closes when this is turned off).` : st.port?.error ? `Port ${port} could not open: ${esc(st.port.error)}` : `Port ${port} is opening…`}
             If Sentry Six Manager runs in Docker, the port must also be published (<code>${port}:${port}</code>).</p>
           <div class="nd-row"><button type="button" class="nd-btn nd-danger" data-off>Turn off…</button></div>`
        : `<p>Off: port ${port} is closed, and the upload address answers "not found".</p>
           <div class="nd-row"><button type="button" class="nd-btn" data-on>Turn on…</button></div>`}
      ${https || st.port?.https ? '' : '<p class="nd-warn">This page is on plain HTTP. The app only uploads over HTTPS: open Sentry Six Manager with https:// for the address and the certificate it pins.</p>'}

      <h3>Tokens (one per car)</h3>
      <p class="nd-muted">Each token is for one car: its first upload ties it to that car's CAN Bridge key, and from then on it can only send that car's logs. A token can only upload: it cannot see footage or change anything else. Only a fingerprint of it is kept here.</p>
      ${token ? `<p><b>New token</b> (shown once: paste it into that car's CAN Bridge app now):</p><div class="nd-box nd-mono" data-token>${esc(token)}</div>
        ${fingerprint ? `<p><b>Certificate SHA-256</b> (the app pins it):</p><div class="nd-box nd-mono">${esc(fingerprint)}</div>` : ''}
        <div class="nd-row"><button type="button" class="nd-btn" data-copy>Copy token</button></div>` : ''}
      ${st.tokens?.length ? `<div class="nd-scroll"><table><thead><tr><th>Token</th><th>Car</th><th>CAN Bridge key</th><th>Made</th><th>Last used</th><th></th></tr></thead><tbody>
        ${st.tokens.map((t) => `<tr><td>${esc(t.label)}</td><td>${esc(carName(st, t.vehicleId))}</td><td class="nd-mono">${esc(t.key || 'not used yet')}</td><td>${esc(when(t.createdAt))}</td><td>${esc(when(t.lastUsedAt))}</td>
          <td><button type="button" class="nd-btn nd-danger" data-revoke="${esc(t.id)}" aria-label="Revoke the token ${esc(t.label)}">Revoke</button></td></tr>`).join('')}</tbody></table></div>` : '<p class="nd-muted">No tokens.</p>'}
      ${st.enabled ? `<div class="nd-row"><select class="nd-btn" data-token-car aria-label="The car for the new token">${st.vehicles.map((v) => `<option value="${esc(v.id)}">${esc(v.name)}</option>`).join('')}</select>
        <button type="button" class="nd-btn" data-new-token>New token for this car…</button></div>` : ''}

      ${st.keys?.length ? `<h3>Cars, pairing and the chain</h3>
      <p class="nd-muted">Every log is signed on the Screenmate with a key that never leaves it. The first signed log pairs the car; after that only logs signed by that key are trusted. Compare the fingerprint below with "Log signing key" in the CAN Bridge app.</p>
      ${st.keys.map((k) => {
        const t = trustOf(k) || { counts: {}, chain: { issues: [] } };
        const c = t.counts || {};
        return `<div class="nd-box">
          <div class="nd-row"><b class="nd-mono">${esc(k)}</b>
            <select data-map="${esc(k)}" aria-label="The car ${esc(k)} is" class="nd-btn">
              <option value="">${st.vehicles.length === 1 ? `${esc(st.vehicles[0].name)} (only car)` : 'Not chosen'}</option>
              ${st.vehicles.map((v) => `<option value="${esc(v.id)}"${st.map[k] === v.id ? ' selected' : ''}>${esc(v.name)}</option>`).join('')}</select></div>
          <p>${t.pin ? `Paired (${esc(t.pin.how)}, ${esc(when(t.pin.pinnedAt))}) with key<br><span class="nd-mono">${esc(t.pin.fingerprint)}</span>` : '<span class="nd-muted">Not paired yet: its first signed log pairs it.</span>'}</p>
          ${t.newKey ? `<p class="nd-warn">Logs signed by another key arrived (${esc(when(t.newKey.firstSeen))}):<br><span class="nd-mono">${esc(t.newKey.fingerprint)}</span><br>If this is your Screenmate (a new one, or the app reinstalled), check the fingerprint in the app, then trust it. Until then those logs are not used.</p>
            <div class="nd-row"><button type="button" class="nd-btn" data-trust="${esc(k)}" data-fp="${esc(t.newKey.fingerprint)}">Trust this key…</button></div>` : ''}
          <p>${c.verified || 0} verified · ${c.failed ? `<span class="nd-warn">${c.failed} failed</span>` : '0 failed'} · ${c.unsigned || 0} unsigned · ${c.waiting || 0} waiting</p>
          <p>${t.chain?.count ? `Chain: logs ${t.chain.first} to ${t.chain.last} of this key${t.chain.issues.length ? '' : ', no gaps, every log follows the one before.'}` : ''}</p>
          ${t.chain?.issues?.length ? `<ul class="nd-warn">${t.chain.issues.slice(0, 20).map((i) => `<li>${esc(i.text)}</li>`).join('')}${t.chain.issues.length > 20 ? `<li>and ${t.chain.issues.length - 20} more</li>` : ''}</ul>` : ''}
          ${t.pin ? `<div class="nd-row"><button type="button" class="nd-btn" data-forget="${esc(k)}">Forget the pairing…</button></div>` : ''}
        </div>`;
      }).join('')}` : ''}

      <h3>Received logs</h3>
      <p>${st.logs ? `${st.logs.toLocaleString()} log${st.logs === 1 ? '' : 's'}, ${esc(size(st.bytes))} in all. Kept exactly as recorded, also the messages nothing knows the meaning of yet. A log that fails its check is kept, but not used.` : 'None yet.'}</p>
      ${files.logs.length ? `<div class="nd-scroll"><table><thead><tr><th>Started</th><th>Car</th><th>Check</th><th>Size</th><th>Frames</th><th>Dropped</th><th>App</th><th></th></tr></thead><tbody>
        ${files.logs.map((f) => {
          const [label, cls, tip] = CHECK[f.check?.status] || CHECK.waiting;
          const why = f.check?.reason ? `${tip ? `${tip} ` : ''}${f.check.reason}` : tip;
          return `<tr><td>${esc(when(f.startedAt))}${f.check?.index !== null && f.check?.index !== undefined ? ` · #${esc(f.check.index)}` : f.seq ? ` · #${f.seq}` : ''}</td><td class="nd-mono">${esc(f.vehicleKey)}</td>
          <td class="${cls}" title="${esc(why)}">${esc(label)}${f.check?.status === 'failed' ? `<br><small>${esc(f.check.reason || '')}</small>${f.check.override ? '<br><small class="nd-warn">used anyway</small>' : ''}` : ''}</td>
          <td>${esc(size(f.bytes))}</td><td>${f.frames === null ? '—' : f.frames.toLocaleString()}</td><td>${f.dropped === null ? '—' : f.dropped.toLocaleString()}</td><td class="nd-mono">${esc(f.appVersion || (f.sidecar ? '' : 'no sidecar yet'))}</td>
          <td>${f.check?.status === 'failed' ? `<button type="button" class="nd-btn" data-use="${esc(f.name)}" data-on="${f.check.override ? '0' : '1'}">${f.check.override ? 'Stop using' : 'Use anyway…'}</button> ` : ''}<button type="button" class="nd-btn nd-danger" data-del="${esc(f.name)}" aria-label="Delete the log ${esc(f.name)}">Delete</button></td></tr>`;
        }).join('')}
      </tbody></table></div>` : ''}

      <h3>Index</h3>
      <p>${st.index.running ? `Decoding${st.index.current ? ` <span class="nd-mono">${esc(st.index.current)}</span>` : ''}… ${st.index.pending ? `${st.index.pending} log${st.index.pending === 1 ? '' : 's'} to go.` : ''}` : 'Every usable log is decoded and ready for the Viewer.'}
        ${st.index.lastError ? `<br><span class="nd-warn">Last problem: ${esc(st.index.lastError)}</span>` : ''}</p>
      <p class="nd-muted">Each log is decoded once when it arrives and passes its check (Model 3/Y DBC, model3dbc), into signals per minute, so the Viewer's dashboard has them at once: Customize, then pick any signal under "CAN".</p>
      <div class="nd-row"><button type="button" class="nd-btn" data-hide>Hide the Nerd button</button></div>`;
  }

  body.addEventListener('change', async (e) => {
    const sel = e.target.closest('[data-map]');
    if (!sel) return;
    if (!(await confirmThen('/api/can/vehicle-map', { method: 'POST', body: JSON.stringify({ key: sel.dataset.map, vehicleId: sel.value || null }) }))) await draw();
  });
  const post = (path, data) => ({ method: 'POST', body: JSON.stringify(data || {}) });
  body.addEventListener('click', async (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.matches('[data-on]') && !b.matches('[data-use]')) {
      const car = body.querySelector('[data-token-car]')?.value || null;
      const d = await confirmThen('/api/can/enable', post('', { vehicleId: car }));
      if (d) { token = d.token; fingerprint = d.fingerprint; await draw(); }
    } else if (b.matches('[data-off]')) {
      if (!confirm('Turn CAN Bridge uploads off? Port 10000 closes and no token works; the logs already here and the tokens are kept.')) return;
      if (await confirmThen('/api/can/disable')) { token = null; await draw(); }
    } else if (b.matches('[data-new-token]')) {
      const car = body.querySelector('[data-token-car]')?.value || null;
      const d = await confirmThen('/api/can/tokens', post('', { vehicleId: car }));
      if (d) { token = d.token; fingerprint = d.fingerprint; await draw(); }
    } else if (b.matches('[data-revoke]')) {
      if (!confirm('Revoke this token? Its CAN Bridge can no longer upload until it gets a new one.')) return;
      if (await confirmThen(`/api/can/tokens/${encodeURIComponent(b.dataset.revoke)}`, { method: 'DELETE' })) await draw();
    } else if (b.matches('[data-copy]')) {
      try { await navigator.clipboard.writeText(token); b.textContent = 'Copied'; } catch { /* select it by hand */ }
    } else if (b.matches('[data-trust]')) {
      if (!confirm(`Trust the key\n${b.dataset.fp}\nfor ${b.dataset.trust}? Check that it matches "Log signing key" in the CAN Bridge app first. Logs signed by it are then checked again and used.`)) return;
      if (await confirmThen(`/api/can/pairing/${encodeURIComponent(b.dataset.trust)}/trust`, post('', { fingerprint: b.dataset.fp }))) await draw();
    } else if (b.matches('[data-forget]')) {
      if (!confirm(`Forget the pairing of ${b.dataset.forget}? The next signed log pairs it again (logs already verified stay verified).`)) return;
      if (await confirmThen(`/api/can/pairing/${encodeURIComponent(b.dataset.forget)}/forget`)) await draw();
    } else if (b.matches('[data-use]')) {
      const on = b.dataset.on === '1';
      if (on && !confirm('Use this log although its check failed? Its data then shows in the Viewer with a warning, and it is used for syncing.')) return;
      if (await confirmThen(`/api/can/files/${encodeURIComponent(b.dataset.use)}/use`, post('', { use: on }))) await draw();
    } else if (b.matches('[data-del]')) {
      const name = b.dataset.del;
      if (!confirm(`Delete ${name}? It cannot be brought back.`)) return;
      if (await confirmThen(`/api/can/files/${encodeURIComponent(name)}`, { method: 'DELETE' })) await draw();
    } else if (b.matches('[data-hide]')) {
      setUnlocked(false);
      document.querySelectorAll('.sentry-nerd-btn').forEach((x) => x.remove());
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
