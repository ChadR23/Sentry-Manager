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

/** The CAN Bridge panel, as a dialog over the page. */
export function openNerdPanel() {
  css();
  const bg = document.createElement('div');
  bg.className = 'sentry-nerd-bg';
  bg.innerHTML = `<div class="sentry-nerd" role="dialog" aria-modal="true" aria-labelledby="nd-title">
    <div class="nd-head"><div><h2 id="nd-title">&gt;_ nerd</h2><p class="nd-muted">CAN Bridge: every CAN message the car sends, recorded by the Screenmate and synced to the footage.</p></div>
      <button type="button" class="nd-btn" data-close aria-label="Close">Close</button></div>
    <div data-body><p class="nd-muted">Loading…</p></div>
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
    const url = `${location.origin}/api/can/logs`;
    const https = location.protocol === 'https:';
    body.innerHTML = `
      <h3>Uploads from the CAN Bridge</h3>
      ${st.enabled
        ? `<p>On since ${esc(new Date(st.since).toLocaleString())}. The app uploads finished logs to:</p>
           <div class="nd-box nd-mono">${esc(url)}</div>
           ${token ? `<p><b>Token</b> (shown once: paste it into the CAN Bridge app now):</p><div class="nd-box nd-mono" data-token>${esc(token)}</div>
             ${fingerprint ? `<p><b>Certificate SHA-256</b> (the app pins it):</p><div class="nd-box nd-mono">${esc(fingerprint)}</div>` : ''}
             <div class="nd-row"><button type="button" class="nd-btn" data-copy>Copy token</button></div>` : '<p class="nd-muted">The token was shown when it was made. Make a new one if the app needs it again (the old one stops working).</p>'}
           <div class="nd-row"><button type="button" class="nd-btn" data-on>New token…</button><button type="button" class="nd-btn nd-danger" data-off>Turn off…</button></div>`
        : `<p>Off: the upload address answers "not found" and takes nothing.</p>
           <div class="nd-row"><button type="button" class="nd-btn" data-on>Turn on…</button></div>`}
      ${https ? '' : '<p class="nd-warn">This page is on plain HTTP. The app only uploads over HTTPS: open Sentry Six Manager with https:// for the address and the certificate it pins.</p>'}
      <p class="nd-muted">The token can only upload CAN logs: it cannot see footage or change anything else.</p>

      <h3>Received logs</h3>
      <p>${st.logs ? `${st.logs.toLocaleString()} log${st.logs === 1 ? '' : 's'}, ${esc(size(st.bytes))} in all. Kept exactly as recorded, also the messages nothing knows the meaning of yet.` : 'None yet.'}</p>
      ${files.logs.length ? `<div class="nd-scroll"><table><thead><tr><th>Started</th><th>Car</th><th>Size</th><th>Frames</th><th>Dropped</th><th>App</th><th></th></tr></thead><tbody>
        ${files.logs.map((f) => `<tr><td>${esc(new Date(f.startedAt).toLocaleString())}${f.seq ? ` · #${f.seq}` : ''}</td><td class="nd-mono">${esc(f.vehicleKey)}</td><td>${esc(size(f.bytes))}</td>
          <td>${f.frames === null ? '—' : f.frames.toLocaleString()}</td><td>${f.dropped === null ? '—' : f.dropped.toLocaleString()}</td><td class="nd-mono">${esc(f.appVersion || (f.sidecar ? '' : 'no sidecar yet'))}</td>
          <td><button type="button" class="nd-btn nd-danger" data-del="${esc(f.name)}" aria-label="Delete the log ${esc(f.name)}">Delete</button></td></tr>`).join('')}
      </tbody></table></div>` : ''}

      <h3>Coming next</h3>
      <p class="nd-muted">Decoding (DBC), syncing each drive to the footage, and the stats you choose on screen in the Viewer.</p>
      <div class="nd-row"><button type="button" class="nd-btn" data-hide>Hide the Nerd button</button></div>`;
  }

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
