// Settings: vehicles, account, interface (background effect, glass, interface
// packs), updates, security, system and the electricity price.

import {
  $, esc, icon, api, upload, state, loadVehicles, setVehicle, bytes, whenFull, fin, toast, confirmDialog, empty
} from '../core.js';

const SECTIONS = [
  ['vehicles', 'Vehicles', 'car'], ['account', 'Account', 'key'], ['interface', 'Interface', 'sparkle'], ['updates', 'Updates', 'download'],
  ['security', 'Security', 'lock'], ['system', 'System', 'cpu'], ['power', 'Electricity', 'bolt']
];
const WEEK = [[1, 'Mon'], [2, 'Tue'], [3, 'Wed'], [4, 'Thu'], [5, 'Fri'], [6, 'Sat'], [0, 'Sun']];
const MAX_RATES = 12;
const priceText = (n) => (fin(n) ? String(n) : '');
function getLocal(k, d) { try { return localStorage.getItem(k) || d; } catch { return d; } }
function setLocal(k, v) { try { localStorage.setItem(k, v); } catch { /* private mode */ } }

export default {
  title: 'Settings',
  kicker: 'Control room',
  icon: 'gear',
  topics: ['vehicles'],
  async mount(ctx) {
    const { body, params } = ctx;
    const section = SECTIONS.some(([k]) => k === params[0]) ? params[0] : 'vehicles';
    const sub = params[1] || null;
    let dead = false;
    body.innerHTML = `<div class="set-layout"><nav class="set-nav" aria-label="Settings sections">${SECTIONS.map(([k, label, ico]) => `<a href="#/settings/${k}" class="${k === section ? 'on' : ''}"${k === section ? ' aria-current="page"' : ''}>${icon(ico)}${label}</a>`).join('')}</nav><div id="set-body"><p class="loading">Loading…</p></div></div>`;
    const box = $('#set-body', body);
    const draw = async () => {
      try {
        await SECTION[section](box, sub, ctx);
      } catch (err) {
        if (!dead) box.innerHTML = `<p class="note bad">${esc(err.message)}</p>`;
      }
    };
    await draw();
    return {
      refresh() {
        // the vehicle list follows live; a form being filled in stays
        if (section === 'vehicles' && !sub) draw();
      },
      destroy() { dead = true; }
    };
  }
};

// ---------- Vehicles ----------
function vehicleForm(v, sys) {
  const versions = sys?.smbVersions || { '3.1.1': 'SMB 3.1.1 (recommended)', '3.02': 'SMB 3.02', '3.0': 'SMB 3.0', 3: 'SMB 3.0 or newer' };
  const s = v?.source || { type: 'smb', version: sys?.smbDefaultVersion || '3.1.1', encrypt: true };
  const smb = s.type !== 'path';
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return `<form id="veh" class="panel" novalidate><div class="panel-head"><h2>${v ? `Edit ${esc(v.name)}` : 'Add a vehicle'}</h2><a class="btn sm ghost" href="#/settings/vehicles">${icon('x')} Close</a></div>
    <div class="form">
      <label class="field">Name<input class="input" name="name" required maxlength="60" value="${esc(v?.name || '')}" placeholder="Daily driver" autocomplete="off"></label>
      <label class="field">Time zone<input class="input" name="timezone" value="${esc(v?.timezone || tz)}" placeholder="America/Chicago" autocomplete="off" autocapitalize="none" spellcheck="false"></label>
      <div class="field full">Where the footage is<div class="seg big" role="group" aria-label="Footage source"><button type="button" data-src="smb" aria-pressed="${smb}">Network share (SMB)</button><button type="button" data-src="path" aria-pressed="${!smb}">Folder in the container</button></div></div>
      <div class="full form" data-for="smb"${smb ? '' : ' hidden'}>
        <label class="field full">Share<input class="input mono" name="share" value="${esc(s.share || '')}" placeholder="//192.168.1.50/TeslaCam" autocomplete="off" autocapitalize="none" spellcheck="false"></label>
        <label class="field">User name<input class="input" name="username" value="${esc(s.username || '')}" autocomplete="off" autocapitalize="none" spellcheck="false"></label>
        <label class="field">Password<input class="input" name="password" type="password" placeholder="${s.passwordSet ? 'saved · leave empty to keep' : ''}" autocomplete="new-password"></label>
        <label class="field">Domain (optional)<input class="input" name="domain" value="${esc(s.domain || '')}" autocomplete="off" autocapitalize="none"></label>
        <label class="field">SMB version<select class="input" name="version">${Object.entries(versions).map(([x, label]) => `<option value="${esc(x)}"${String(s.version || '3.1.1') === x ? ' selected' : ''}>${esc(label)}</option>`).join('')}</select></label>
        <label class="field">Port (optional)<input class="input" name="port" inputmode="numeric" value="${esc(s.port || '')}" placeholder="445"></label>
        <label class="check full"><input type="checkbox" name="encrypt"${s.encrypt === false ? '' : ' checked'}> Encrypt the connection (recommended)</label>
        <p class="muted small full">Only SMB 3 is used and every connection is signed, so nobody can change the footage or pose as your NAS; without encryption others on the network could watch it. Use a NAS account with access to this share only.</p>
      </div>
      <div class="full" data-for="path"${smb ? ' hidden' : ''}>
        <label class="field">Folder<input class="input mono" name="path" value="${esc(s.path || '')}" placeholder="/footage/weekend-car" autocomplete="off" autocapitalize="none" spellcheck="false"></label>
        <p class="muted small" style="margin-top:8px">A folder you mounted into the container yourself (a bind mount or a Docker CIFS volume).</p>
      </div>
    </div>
    <p class="err" id="veh-err" role="alert"></p>
    <div class="actions">${v ? `<button class="btn danger" type="button" id="veh-del">${icon('trash')} Remove vehicle</button><span class="spacer"></span>` : ''}<a class="btn" href="#/settings/vehicles">Cancel</a><button class="btn primary" type="submit">${v ? 'Save' : 'Add vehicle'}</button></div>
  </form>`;
}

async function vehicles(box, sub) {
  const sys = state.system || await api('/api/system').catch(() => null);
  state.system = sys;
  const editing = sub === 'new' ? 'new' : sub ? state.vehicles.find((v) => v.id === sub) || null : null;
  const list = state.vehicles.map((v) => {
    const s = v.share;
    const ok = s?.healthy;
    return `<div class="veh-row"><span class="orb">${icon('car')}</span><div style="min-width:0"><b>${esc(v.name)}</b> <span class="muted small">${esc(v.timezone)}</span><br>
      <span class="small mono" style="overflow-wrap:anywhere">${esc(v.source.type === 'smb' ? v.source.share : v.source.path)}</span><br>
      <span class="small"><span class="dot ${ok ? (s.writable === false ? 'warn' : 'ok') : 'bad'}"></span> ${ok ? (s.writable === false ? 'Read-only' : 'Connected') : esc(s?.lastError || 'Unavailable')}${v.security ? ` · ${esc(v.security)}` : ''}${fin(s?.freeBytes) ? ` · ${bytes(s.freeBytes)} free` : ''}</span>${s?.warning ? `<br><span class="muted tiny">${esc(s.warning)}</span>` : ''}</div>
      <div class="row">${v.source.type === 'smb' ? `<button class="btn sm" type="button" data-reconnect="${esc(v.id)}">${icon('refresh')} Reconnect</button>` : ''}<a class="btn sm" href="#/settings/vehicles/${encodeURIComponent(v.id)}">Edit</a></div></div>`;
  }).join('');
  box.innerHTML = `${editing !== null || sub === 'new' ? vehicleForm(editing === 'new' ? null : editing, sys) : ''}
    <section class="panel"><div class="panel-head"><h2>Vehicles</h2><a class="btn primary" href="#/settings/vehicles/new">${icon('plus')} Add vehicle</a></div>
      ${state.vehicles.length ? `<div class="veh-list">${list}</div>` : empty('No vehicles yet', 'Add the share or folder where a car’s TeslaCam footage is.')}</section>`;
  if (sub && editing === null && sub !== 'new') toast('That vehicle no longer exists.', 'bad');

  box.querySelectorAll('[data-reconnect]').forEach((b) => b.addEventListener('click', async () => {
    b.disabled = true;
    try {
      const out = await api(`/api/vehicles/${encodeURIComponent(b.dataset.reconnect)}/reconnect`, { body: {} });
      toast(out.share?.healthy ? 'Connected.' : (out.share?.lastError || 'Still not reachable.'), out.share?.healthy ? 'ok' : 'bad');
      await loadVehicles();
    } catch (err) { toast(err.message, 'bad'); }
    vehicles(box, sub);
  }));
  const form = $('#veh', box);
  if (!form) return;
  let type = form.querySelector('[data-src][aria-pressed="true"]').dataset.src;
  form.querySelectorAll('[data-src]').forEach((b) => b.addEventListener('click', () => {
    type = b.dataset.src;
    form.querySelectorAll('[data-src]').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
    form.querySelectorAll('[data-for]').forEach((x) => { x.hidden = x.dataset.for !== type; });
  }));
  form.querySelector('[name=name]').focus({ preventScroll: true });
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(form);
    const err = $('#veh-err', form);
    err.textContent = '';
    const body = {
      name: String(fd.get('name') || '').trim(), timezone: String(fd.get('timezone') || '').trim(),
      source: type === 'path'
        ? { type: 'path', path: String(fd.get('path') || '').trim() }
        : { type: 'smb', share: String(fd.get('share') || '').trim(), username: String(fd.get('username') || ''), password: fd.get('password') || undefined, domain: String(fd.get('domain') || ''), version: fd.get('version'), encrypt: fd.get('encrypt') === 'on', port: String(fd.get('port') || '').trim() || null }
    };
    if (!body.name) { err.textContent = 'Give the vehicle a name.'; return; }
    if (editing && editing !== 'new') {
      const was = editing.source || {};
      const same = type === was.type && (type === 'path'
        ? body.source.path === was.path
        : ['share', 'username', 'domain', 'version'].every((k) => String(body.source[k] ?? '') === String(was[k] ?? ''))
          && body.source.encrypt === (was.encrypt !== false) && String(body.source.port ?? '') === String(was.port ?? '') && !body.source.password);
      // a rename alone needs no password
      if (same) delete body.source;
    }
    const btn = form.querySelector('[type=submit]');
    btn.disabled = true;
    try {
      const saved = editing === 'new' || !editing
        ? await api('/api/vehicles', { body })
        : await api(`/api/vehicles/${encodeURIComponent(editing.id)}`, { method: 'PUT', body });
      await loadVehicles();
      setVehicle(saved.id);
      toast('Saved. Connecting to the footage…');
      location.hash = '#/settings/vehicles';
    } catch (x) {
      err.textContent = x.message;
    } finally {
      btn.disabled = false;
    }
  });
  $('#veh-del', form)?.addEventListener('click', async () => {
    if (!(await confirmDialog({ title: `Remove ${editing.name}?`, body: '<p>Sentry Six Manager forgets the vehicle and disconnects its share. No footage is deleted.</p>', ok: 'Remove', danger: true }))) return;
    try {
      await api(`/api/vehicles/${encodeURIComponent(editing.id)}`, { method: 'DELETE' });
      await loadVehicles();
      toast('Vehicle removed.');
      location.hash = '#/settings/vehicles';
    } catch (x) { toast(x.message, 'bad'); }
  });
}

// ---------- Account ----------
async function account(box) {
  box.innerHTML = `<section class="panel"><div class="panel-head"><h2>Change your password</h2></div>
    <form id="pw" class="form" novalidate>
      <label class="field full">Current password<input class="input" type="password" name="current" autocomplete="current-password" required></label>
      <label class="field">New password<input class="input" type="password" name="next" autocomplete="new-password" minlength="8" required></label>
      <label class="field">New password again<input class="input" type="password" name="again" autocomplete="new-password" minlength="8" required></label>
      <p class="muted small full">At least 8 characters. Every other signed-in browser is signed out.</p>
      <p class="err full" id="pw-err" role="alert"></p>
      <div class="full actions" style="margin-top:0"><button class="btn primary" type="submit">Change password</button></div></form></section>
    <section class="panel"><div class="panel-head"><h2>This browser</h2></div><div class="actions start"><button class="btn" type="button" id="so">${icon('signout')} Sign out</button></div></section>`;
  $('#pw', box).addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const err = $('#pw-err', box);
    err.textContent = '';
    if (String(fd.get('next')).length < 8) { err.textContent = 'Choose at least 8 characters.'; return; }
    if (fd.get('next') !== fd.get('again')) { err.textContent = 'The new passwords do not match.'; return; }
    try {
      await api('/api/auth/password', { body: { current: fd.get('current'), next: fd.get('next') } });
      toast('Password changed.');
      e.target.reset();
    } catch (x) { err.textContent = x.message; }
  });
  $('#so', box).addEventListener('click', async () => {
    await api('/api/auth/logout', { body: {} }).catch(() => {});
    location.href = '/login';
  });
}

// ---------- Interface ----------
async function iface(box) {
  const ui = await api('/api/ui-packs');
  const fx = document.documentElement.dataset.effect || 'calm';
  const glass = getLocal('aurora:glass', 'chrome');
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const day = (iso) => (iso ? new Date(iso).toLocaleDateString() : '');
  box.innerHTML = `<section class="panel"><div class="panel-head"><h2>Background effect</h2><span class="muted small">this browser only</span></div>
      <p class="lead">The northern lights behind the glass. Calm draws fewer, slower ribbons (less work for phones); Off keeps a still sky.${reduce ? ' Your device asks for reduced motion, so the sky stays still whatever you pick.' : ''}</p>
      <div class="fx-choice" style="margin-top:14px" role="radiogroup" aria-label="Background effect">${[['full', 'Full', 'flowing aurora, twinkling stars, a shooting star now and then'], ['calm', 'Calm', 'gentler and lighter'], ['off', 'Off', 'a still, painted sky']].map(([k, l, h]) => `<label class="choice"><input type="radio" name="fx" value="${k}"${fx === k ? ' checked' : ''}><b>${l}</b><span>${h}</span></label>`).join('')}</div>
      <div class="fx-choice" style="margin-top:14px" role="radiogroup" aria-label="Glass">${[['chrome', 'Frosted chrome', 'the dock, bars and dialogs blur the sky; windows are tinted glass (smoothest)'], ['frosted', 'Frosted everywhere', 'windows blur the sky too: needs a strong GPU'], ['solid', 'Solid glass', 'no blur at all: the lightest for older devices']].map(([k, l, h]) => `<label class="choice"><input type="radio" name="glass" value="${k}"${glass === k ? ' checked' : ''}><b>${l}</b><span>${h}</span></label>`).join('')}</div></section>
    <section class="panel"><div class="panel-head"><h2>Interface</h2></div>
      <p class="lead">How Sentry Six Manager looks and works for everyone who signs in. <b>Original</b> is the built-in interface; the others are packs you uploaded.</p>
      ${ui.original ? `<div class="note warn" style="margin-top:12px">This browser shows the original interface because you opened <span class="mono">/original</span>${ui.active ? `; everyone else sees <b>${esc(ui.packs.find((x) => x.id === ui.active)?.name || '')}</b>` : ''}. <div class="actions start"><a class="btn sm" href="/original?off=1">Show the chosen interface</a></div></div>` : ''}
      <label class="field" style="margin-top:16px;max-width:420px">Interface for everyone<select class="input" id="ui-pick"><option value=""${ui.active ? '' : ' selected'}>Original</option>${ui.packs.map((x) => `<option value="${esc(x.id)}"${x.id === ui.active ? ' selected' : ''}>${esc(x.name)}</option>`).join('')}</select></label>
      <div style="margin-top:16px">${ui.packs.map((x) => `<div class="pack-row"><div style="min-width:0"><b>${esc(x.name)}</b>${x.id === ui.active ? ' <span class="chip green">In use</span>' : ''}${x.description ? `<br><span class="muted small">${esc(x.description)}</span>` : ''}<br><span class="muted tiny">${x.author ? `by ${esc(x.author)} · ` : ''}${(x.replaces || []).map((k) => (k === 'web' ? 'pages' : 'Viewer and Encoder')).join(', ')} · ${x.files} files · uploaded ${esc(day(x.uploadedAt))}</span></div>
        <button class="btn sm danger" type="button" data-ui-del="${esc(x.id)}">${icon('trash')} Delete</button></div>`).join('')}</div>
      <div class="actions start">
        <label class="btn primary file-pick">${icon('upload')} Upload a pack (.zip)<input type="file" id="ui-file" accept=".zip,application/zip" aria-label="Upload an interface pack"></label>
        <a class="btn" href="/api/ui-packs/original.zip" download>${icon('download')} Download the original to start from</a>
      </div>
      <p class="muted small" style="margin-top:14px">A pack replaces the built-in files with the same path, so it can change one stylesheet or the whole interface. <b>A pack’s scripts run as whoever is signed in and can do anything you can</b>: only upload packs you made or trust. Uploading or choosing one asks for your password.</p>
      <p class="muted small" style="margin-top:8px">If a pack ever breaks the pages, open <span class="mono">${esc(location.origin)}/original</span>: that browser then shows the original interface, and you can switch back here.</p><div class="actions start"><a class="btn sm" href="/original">Open /original in this browser</a></div>
    </section>`;

  box.onchange = async (e) => {
    const t = e.target;
    if (t.name === 'fx') {
      setLocal('aurora:effect', t.value);
      window.auroraSky?.setMode(t.value);
      toast(`Background effect: ${t.value}.`);
      return;
    }
    if (t.name === 'glass') {
      setLocal('aurora:glass', t.value);
      document.documentElement.classList.toggle('no-blur', t.value === 'solid');
      document.documentElement.classList.toggle('frost-all', t.value === 'frosted');
      return;
    }
    if (t.id === 'ui-pick') {
      try {
        await api('/api/ui-packs/active', { method: 'PUT', body: { id: t.value || null } });
        location.reload();
      } catch (err) {
        t.value = ui.active || '';
        toast(err.message, 'bad');
      }
      return;
    }
    if (t.id === 'ui-file') {
      const f = t.files[0];
      t.value = '';
      if (!f) return;
      try {
        const out = await upload('/api/ui-packs/upload', f, { 'Content-Type': 'application/zip', 'X-File-Name': encodeURIComponent(f.name) });
        if (await confirmDialog({ title: 'Use it now?', body: `<p><b>${esc(out.pack.name)}</b> is installed. Use it for everyone now? You can switch back to Original here any time.</p>`, ok: 'Use it', cancel: 'Not now' })) {
          await api('/api/ui-packs/active', { method: 'PUT', body: { id: out.pack.id } });
          location.reload();
        } else iface(box);
      } catch (err) { toast(err.message, 'bad'); }
    }
  };
  box.querySelectorAll('[data-ui-del]').forEach((b) => b.addEventListener('click', async () => {
    const x = ui.packs.find((p) => p.id === b.dataset.uiDel);
    if (!(await confirmDialog({ title: 'Delete this interface?', body: `<p><b>${esc(x?.name || '')}</b> is deleted from the server.${x?.id === ui.active ? ' Everyone gets the original interface.' : ''}</p>`, ok: 'Delete', danger: true }))) return;
    try {
      await api(`/api/ui-packs/${encodeURIComponent(x.id)}`, { method: 'DELETE' });
      if (x.id === ui.active) location.reload();
      else iface(box);
    } catch (err) { toast(err.message, 'bad'); }
  }));
}

// ---------- Updates ----------
async function updates(box) {
  const u = await api('/api/updates');
  const cur = u.current || {};
  const running = `${cur.sha ? `${esc(cur.sha.slice(0, 7))}${u.tag ? ` (${esc(u.tag)})` : ''}` : 'built from source'}${cur.builtAt ? ` · built ${esc(String(cur.builtAt).slice(0, 10))}` : ''}`;
  const how = '<code>docker compose pull &amp;&amp; docker compose up -d</code>';
  const l = u.latest;
  box.innerHTML = `<section class="panel"><div class="panel-head"><h2>Updates</h2>${u.updateAvailable ? '<span class="chip green">Update available</span>' : ''}</div>
    <p class="lead">${!u.enabled ? (u.image ? `Checking for updates is turned off (UPDATE_CHECK=off). To update, run ${how} where you set up Sentry Six Manager.` : 'This copy was built from source. To update it, build the image again from the new code.') : `Updates come as a new image: run ${how} where you set up Sentry Six Manager. Settings, footage and the Recycle Bin stay as they are.`}</p>
    <dl class="kv" style="margin-top:16px"><dt>Running</dt><dd class="mono">${running}</dd>
      ${u.enabled ? `<dt>Newest</dt><dd>${l ? `<span class="mono">${l.revision ? `${esc(l.revision.slice(0, 7))} · ` : ''}published ${esc(String(l.created || '').slice(0, 10) || '?')}</span>` : u.error ? esc(u.error) : 'not checked yet'}${u.checkedAt ? ` <span class="muted">(checked ${esc(whenFull(u.checkedAt))})</span>` : ''}</dd>` : ''}</dl>
    ${u.enabled ? `<div class="actions start"><button class="btn" type="button" id="upd">${icon('refresh')} Check now</button></div>` : ''}</section>`;
  $('#upd', box)?.addEventListener('click', async (e) => {
    e.target.disabled = true;
    try {
      const out = await api('/api/updates/check', { body: {} });
      toast(out.error || (out.updateAvailable ? 'An update is available.' : 'This is the newest version.'), out.error ? 'bad' : 'ok');
    } catch (err) { toast(err.message, 'bad'); }
    updates(box);
  });
}

// ---------- Security ----------
async function security(box) {
  const sec = await api('/api/security');
  const tls = sec.tls || {};
  const host = (sec.currentHost || '').replace(/:\d+$/, '').replace(/^\[|\]$/g, '');
  const covered = !host || (tls.hostnames || []).map((h) => h.toLowerCase()).includes(host.toLowerCase());
  const fp = (s) => esc(s || '?').replace(/:/g, ':<wbr>');
  let html = `<dl class="kv"><dt>This connection</dt><dd>${sec.https ? 'HTTPS (encrypted)' : '<b style="color:var(--bad)">not encrypted</b>: others on the network could read your password and the footage. Use https://.'}</dd>
    <dt>Server process</dt><dd>${sec.runningAsRoot ? 'runs as root (not supervised; fine for development, not for the Docker image)' : 'runs as an unprivileged user; only the supervisor can mount shares'}</dd>`;
  if (sec.tlsMode === 'off') html += '<dt>HTTPS</dt><dd>turned off (TLS_MODE=off): only behind a reverse proxy that does HTTPS.</dd></dl>';
  else if (tls.mode === 'own') html += `<dt>Certificate</dt><dd>your own (TLS_CERT_FILE) · ${esc((tls.certificate?.names || []).join(', '))} · valid until ${esc(tls.certificate?.validTo || '?')}</dd><dt>Fingerprint</dt><dd class="mono small">${fp(tls.certificate?.fingerprint)}</dd></dl>`;
  else if (tls.error) html += `<dt>Certificate</dt><dd>${esc(tls.error)}</dd></dl>`;
  else {
    html += `<dt>Certificate fingerprint</dt><dd class="mono small">${fp(tls.certificate?.fingerprint)}</dd>
      <dt>Certificate</dt><dd>Sentry Six Manager’s own · until ${esc(tls.certificate?.validTo || '?')}, then renews by itself</dd>
      <dt>Covers</dt><dd>${esc((tls.hostnames || []).join(', '))}</dd>
      <dt>Certificate authority</dt><dd>until ${esc(tls.ca?.validTo || '?')} · <span class="mono small">${fp(tls.ca?.fingerprint)}</span></dd></dl>
      <p class="lead" style="margin-top:14px">Each device shows the browser’s certificate warning once; continue past it and the device remembers. To be sure it is this server, compare the fingerprint above with the browser’s certificate details or the container log. If a device that continued before warns again and nothing changed here, don’t continue. No warning at all: install the certificate authority below (compare its fingerprint first).</p>
      ${covered ? '' : `<div class="note warn" style="margin-top:12px">You opened this page as <b>${esc(host)}</b>, which the certificate doesn’t cover. <button class="btn sm" type="button" id="add-host" data-host="${esc(host)}">Add ${esc(host)}</button></div>`}
      <details class="more-info"><summary>How to install the certificate authority</summary><ul class="list small" style="margin-top:8px">
        <li><div><b>iPhone / iPad:</b> open the download in Safari, then Settings › General › VPN &amp; Device Management to install it, and Settings › General › About › Certificate Trust Settings to turn on full trust.</div></li>
        <li><div><b>Android:</b> Settings › Security › Encryption &amp; credentials › Install a certificate › CA certificate.</div></li>
        <li><div><b>Windows:</b> open the file › Install Certificate › Local Machine › Trusted Root Certification Authorities.</div></li>
        <li><div><b>macOS:</b> open it in Keychain Access (System), then set Trust to Always Trust.</div></li>
        <li><div><b>Firefox:</b> Settings › Privacy &amp; Security › Certificates › View Certificates › Authorities › Import.</div></li></ul></details>
      <form id="hosts" class="form" style="margin-top:16px" novalidate>
        <label class="field full">Extra names and addresses for the certificate<input class="input" name="hostnames" value="${esc((tls.editable || []).join(', '))}" placeholder="192.168.1.20, nas.local" autocomplete="off" autocapitalize="none" spellcheck="false"></label>
        <p class="muted small full">The addresses or names you type to reach this server. Saving makes a new certificate (devices that continued past the warning see it once more). From TLS_HOSTNAMES: ${esc((tls.fromEnv || []).join(', ') || 'none')}.</p>
        <div class="full actions" style="margin-top:0"><a class="btn" href="/api/security/ca.crt" download>${icon('download')} Download certificate authority</a><button class="btn primary" type="submit">Save names</button></div></form>`;
  }
  box.innerHTML = `<section class="panel"><div class="panel-head"><h2>Security</h2></div>${html}</section>`;
  const save = async (names) => {
    if (!(await confirmDialog({ title: 'Make a new certificate?', body: '<p>The certificate will cover the new names. Devices that continued past the warning before will see it once more; devices with the certificate authority installed won’t.</p>', ok: 'Save names' }))) return;
    try {
      const out = await api('/api/security/hostnames', { method: 'PUT', body: { hostnames: names } });
      toast(`${out.caReplaced ? 'Saved. The certificate authority was replaced: install the new one on your devices.' : 'Saved.'} Reloading for the new certificate…`);
      setTimeout(() => location.reload(), 2500);
    } catch (err) { toast(err.message, 'bad'); }
  };
  $('#hosts', box)?.addEventListener('submit', (e) => {
    e.preventDefault();
    save(String(new FormData(e.target).get('hostnames') || '').split(/[\s,]+/).filter(Boolean));
  });
  $('#add-host', box)?.addEventListener('click', (e) => save([...(tls.editable || []), e.target.closest('button').dataset.host]));
}

// ---------- System ----------
async function system(box) {
  const sys = await api('/api/system');
  state.system = sys;
  const caps = sys.converter?.capabilities || {};
  const g = sys.gpu || { gpus: [], nvidia: [], hints: [] };
  const gpus = [...(g.nvidia || []).map((x) => `${/^nvidia\b/i.test(x.name || '') ? '' : 'NVIDIA '}${esc(x.name)} (driver ${esc(x.driver)})`),
    ...(g.gpus || []).filter((x) => x.vendor !== 'nvidia').map((x) => (x.virtual ? `${esc(x.name)} · ${esc(x.node)} · not a GPU` : `${esc(x.name || x.vendorName)} · ${esc(x.node)}${x.passedThrough ? (x.encodes ? ` · encodes ${Object.entries(x.encodes).filter(([, y]) => y).map(([k]) => k.toUpperCase()).join(', ') || 'nothing'}` : '') : ' · not passed into the container'}`))];
  const v = sys.version || {};
  box.innerHTML = `<section class="panel"><div class="panel-head"><h2>System</h2></div><dl class="kv">
    <dt>Version</dt><dd class="mono">${esc(v.version || v.sha || 'development')}${v.builtAt ? ` · ${esc(String(v.builtAt).slice(0, 10))}` : ''}</dd>
    <dt>Converter</dt><dd>${sys.converter?.ready ? `ready · replace originals ${esc(caps.replacement)} · cleanup ${esc(caps.ownershipCleanup)}` : `not ready (${esc(sys.converter?.error || 'starting')})`}</dd>
    <dt>Safe rename helper</dt><dd>${sys.nativeHelper ? 'installed' : 'missing (link + unlink fallback)'}</dd>
    <dt>GPUs</dt><dd>${gpus.length ? gpus.join('<br>') : 'none visible (the CPU encoders are used)'}</dd>
    ${(g.hints || []).length ? `<dt>GPU hints</dt><dd>${g.hints.map(esc).join('<br>')}</dd>` : ''}
    <dt>Data volume free</dt><dd>${bytes(sys.dataFree)}</dd>
    <dt>Server time zone</dt><dd>${esc(sys.timezone)}</dd>
    <dt>HTTPS</dt><dd>${sys.security?.https ? 'on' : 'off'} · TLS mode ${esc(sys.security?.tlsMode || '')}${sys.security?.supervised ? ' · supervised' : ''}</dd></dl></section>`;
}

// ---------- Electricity ----------
function rateRow(r = {}) {
  const days = new Set(Array.isArray(r.days) ? r.days : [0, 1, 2, 3, 4, 5, 6]);
  return `<div class="rate" data-rate>
    <label class="field">Name<input class="input" data-k="label" maxlength="24" value="${esc(r.label || '')}" placeholder="Off-peak"></label>
    <label class="field">Price per kWh<input class="input" data-k="price" inputmode="decimal" value="${esc(priceText(r.price))}" placeholder="0.12"></label>
    <label class="field">From<input class="input" type="time" data-k="from" value="${esc(r.from || '23:00')}"></label>
    <label class="field">To<input class="input" type="time" data-k="to" value="${esc(r.to || '07:00')}"></label>
    <div class="days" role="group" aria-label="Days">${WEEK.map(([d, n]) => `<label><input type="checkbox" value="${d}"${days.has(d) ? ' checked' : ''}> ${n}</label>`).join('')}<span class="spacer"></span><button class="btn sm ghost" type="button" data-rate-del>${icon('x')} Remove</button></div>
  </div>`;
}

async function power(box) {
  const [{ power: p }, sys] = await Promise.all([api('/api/settings'), state.system ? Promise.resolve(state.system) : api('/api/system').catch(() => null)]);
  let mode = p.mode === 'tou' ? 'tou' : 'flat';
  box.innerHTML = `<section class="panel"><div class="panel-head"><h2>Electricity price</h2></div>
    <p class="lead">For the cost next to energy on the Sky, the Encoder and Jobs. Leave it empty to show energy only.</p>
    <form id="pwr" class="stack" style="margin-top:16px" novalidate>
      <div class="seg big" role="group" aria-label="Plan"><button type="button" data-mode="flat" aria-pressed="${mode === 'flat'}">One price</button><button type="button" data-mode="tou" aria-pressed="${mode === 'tou'}">Time of use</button></div>
      <div class="form">
        <label class="field">Currency<input class="input" name="currency" maxlength="3" value="${esc(p.currency || '$')}" placeholder="$"></label>
        <label class="field" data-plan="flat"${mode === 'tou' ? ' hidden' : ''}>Price per kWh<input class="input" name="pricePerKwh" inputmode="decimal" value="${esc(priceText(p.pricePerKwh))}" placeholder="0.15"></label>
        <label class="field" data-plan="tou"${mode === 'tou' ? '' : ' hidden'}>Other hours (per kWh)<input class="input" name="defaultPrice" inputmode="decimal" value="${esc(priceText(p.defaultPrice))}" placeholder="0.25"></label>
      </div>
      <div data-plan="tou"${mode === 'tou' ? '' : ' hidden'}>
        <p class="muted small">Rates in order: the first whose days and hours match is used, otherwise the price for other hours. A rate from 23:00 to 07:00 runs over midnight and belongs to the day it starts. Times are the server’s${sys?.timezone ? ` (${esc(sys.timezone)})` : ''}.</p>
        <div id="rates" style="margin-top:12px">${(p.rates || []).map(rateRow).join('')}</div>
        <div class="actions start"><button class="btn sm" type="button" id="add-rate">${icon('plus')} Add a rate</button></div>
      </div>
      <div class="actions"><button class="btn primary" type="submit">Save price</button></div>
    </form></section>`;
  const form = $('#pwr', box);
  const rates = $('#rates', box);
  const count = () => rates.querySelectorAll('[data-rate]').length;
  const addBtn = $('#add-rate', box);
  const sync = () => { addBtn.disabled = count() >= MAX_RATES; };
  sync();
  form.querySelectorAll('[data-mode]').forEach((b) => b.addEventListener('click', () => {
    mode = b.dataset.mode;
    form.querySelectorAll('[data-mode]').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
    form.querySelectorAll('[data-plan]').forEach((x) => { x.hidden = x.dataset.plan !== mode; });
    if (mode === 'tou' && !count()) rates.insertAdjacentHTML('beforeend', rateRow({ label: 'Off-peak' }));
    sync();
  }));
  addBtn.addEventListener('click', () => {
    if (count() >= MAX_RATES) return;
    rates.insertAdjacentHTML('beforeend', rateRow(count() ? { label: 'Peak', from: '16:00', to: '21:00', days: [1, 2, 3, 4, 5] } : { label: 'Off-peak' }));
    sync();
  });
  rates.addEventListener('click', (e) => {
    const d = e.target.closest('[data-rate-del]');
    if (!d) return;
    d.closest('[data-rate]').remove();
    sync();
  });
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(form);
    const num = (v) => (String(v ?? '').trim() === '' ? null : Number(String(v).replace(',', '.')));
    const list = [...rates.querySelectorAll('[data-rate]')].map((row) => {
      const v = (k) => row.querySelector(`[data-k="${k}"]`).value;
      return { label: v('label').trim(), price: num(v('price')), from: v('from'), to: v('to'), days: [...row.querySelectorAll('.days input:checked')].map((x) => Number(x.value)) };
    });
    const prices = mode === 'tou' ? [num(fd.get('defaultPrice')), ...list.map((r) => r.price)] : [num(fd.get('pricePerKwh'))];
    if (prices.some(Number.isNaN)) { toast('Enter prices as numbers, like 0.15.', 'bad'); return; }
    try {
      const next = await api('/api/settings/power', {
        method: 'PUT',
        body: { currency: String(fd.get('currency') || '').trim() || '$', mode, pricePerKwh: num(fd.get('pricePerKwh')), defaultPrice: num(fd.get('defaultPrice')), rates: mode === 'tou' ? list : (p.rates || []) }
      });
      state.power = next;
      toast(mode === 'tou' ? 'Saved. Costs follow the plan from now on.' : next.pricePerKwh === null ? 'Saved. Energy shows without a cost.' : 'Saved.');
    } catch (err) { toast(err.message, 'bad'); }
  });
}

const SECTION = { vehicles, account, interface: iface, updates, security, system, power };
