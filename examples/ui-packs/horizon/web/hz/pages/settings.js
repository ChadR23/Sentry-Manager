// Settings: the garage (vehicles), account, interface packs, the background
// effect, updates, security, system and the electricity price.
import { h, ico, api, send, app, pickCar, loadCars, size, stampFull, toast, ask, act, ok, local, segs, onSegs, pill, panelHead } from '../core.js';

const TABS = [['vehicles', 'Vehicles', 'car'], ['account', 'Account', 'lock'], ['interface', 'Interface', 'horizon'], ['display', 'Background', 'hud'], ['updates', 'Updates', 'download'], ['security', 'Security', 'shield'], ['system', 'System', 'info'], ['power', 'Electricity', 'bolt']];
const WEEK = [[1, 'Mon'], [2, 'Tue'], [3, 'Wed'], [4, 'Thu'], [5, 'Fri'], [6, 'Sat'], [0, 'Sun']];
let system = null;

export default {
  async mount(el, { sub, params, go, status }) {
    const tab = TABS.some(([k]) => k === sub.split('/')[0]) ? sub.split('/')[0] : 'vehicles';
    el.innerHTML = `<section class="ptitle hud"><div><h1 class="chrome">Settings</h1></div></section>
      <div class="settings">
        <nav class="stabs hud" aria-label="Settings sections">${TABS.map(([k, l, i]) => `<a href="#/settings/${k}" class="stab${k === tab ? ' on' : ''}"${k === tab ? ' aria-current="page"' : ''}>${ico(i)}<span>${l}</span></a>`).join('')}</nav>
        <div class="spanel" id="sp"><div class="loading"><i></i><i></i><i></i></div></div>
      </div>`;
    status(TABS.find(([k]) => k === tab)[1]);
    el.querySelector('.stab.on')?.scrollIntoView?.({ block: 'nearest', inline: 'center' });
    const box = el.querySelector('#sp');
    const parts = { vehicles, account, interface: iface, display, updates, security, system: sys, power };
    await parts[tab](box, { params, go });
    return {
      onTopics(t) {
        if (tab === 'vehicles' && t.includes('vehicles') && !box.querySelector('#v-form')) vehicles(box, { params: new URLSearchParams(), go });
      }
    };
  }
};

// ---------- vehicles ----------
async function vehicles(box, { params, go }) {
  if (!system) system = await api('/api/system').catch(() => null);
  const editId = params.get('edit');
  const adding = params.get('add') === '1';
  const v = editId ? app.vehicles.find((x) => x.id === editId) : null;
  box.innerHTML = `<section class="panel hud">${panelHead(`${ico('car')}Garage`, `<a class="btn go sm" href="#/settings/vehicles?add=1">${ico('plus')}Add vehicle</a>`)}
    <div class="garage">${app.vehicles.map((x) => `<div class="bay"><div class="bay-h"><b>${h(x.name)}</b>${x.share?.healthy ? (x.share.writable === false ? pill('read-only', 'org') : pill('connected', 'grn')) : pill('unavailable', 'red')}</div>
      <p class="small dim mono wrap-any">${h(x.source.type === 'smb' ? x.source.share : x.source.path)}</p>
      <p class="small faint">${h(x.timezone)} · id <span class="mono">${h(x.id)}</span>${x.security ? ` · ${h(x.security)}` : ''}</p>
      ${x.share?.lastError ? `<p class="small badtx">${h(x.share.lastError)}</p>` : ''}
      <div class="row"><button class="btn sm" type="button" data-scan="${h(x.id)}">${ico('refresh')}Scan</button><button class="btn sm" type="button" data-recon="${h(x.id)}">Reconnect</button><a class="btn sm" href="#/settings/vehicles?edit=${encodeURIComponent(x.id)}">Edit</a></div></div>`).join('') || '<p class="dim">No vehicles yet.</p>'}</div></section>
    ${adding || v ? carForm(v) : ''}`;
  box.querySelectorAll('[data-scan]').forEach((b) => { b.onclick = () => act(b, async () => { await api(`/api/vehicles/${encodeURIComponent(b.dataset.scan)}/scan`, { body: {} }); toast('Scanning. Jobs shows the progress.'); }); });
  box.querySelectorAll('[data-recon]').forEach((b) => { b.onclick = () => act(b, async () => { const out = await api(`/api/vehicles/${encodeURIComponent(b.dataset.recon)}/reconnect`, { body: {} }); toast(out.share?.healthy === false ? `Still unavailable: ${out.share.lastError || ''}` : 'Reconnected.'); await loadCars(); }); });
  const form = box.querySelector('#v-form');
  if (!form) return;
  form.scrollIntoView({ block: 'start' });
  let type = v?.source?.type === 'path' ? 'path' : 'smb';
  onSegs(form, 'src', (t) => { type = t; form.querySelectorAll('[data-src]').forEach((n) => { n.hidden = n.dataset.src !== t; }); });
  form.onsubmit = (e) => {
    e.preventDefault();
    const fd = new FormData(form);
    const body = {
      name: String(fd.get('name') || '').trim(), timezone: String(fd.get('timezone') || '').trim(),
      source: type === 'path'
        ? { type: 'path', path: String(fd.get('path') || '').trim() }
        : { type: 'smb', share: String(fd.get('share') || '').trim(), username: fd.get('username'), password: fd.get('password') || undefined, domain: fd.get('domain'), version: fd.get('version'), encrypt: fd.get('encrypt') === 'on', port: fd.get('port') ? Number(fd.get('port')) : null }
    };
    if (v) {
      // send the source only when it changed, so a rename needs no password
      const was = v.source || {};
      const same = type === was.type && (type === 'path' ? body.source.path === was.path
        : ['share', 'username', 'domain', 'version'].every((k) => String(body.source[k] ?? '') === String(was[k] ?? '')) && body.source.encrypt === (was.encrypt !== false) && String(body.source.port ?? '') === String(was.port ?? '') && !body.source.password);
      if (same) delete body.source;
    }
    act(form.querySelector('[type=submit]'), async () => {
      const saved = v ? await api(`/api/vehicles/${encodeURIComponent(v.id)}`, { method: 'PUT', body }) : await api('/api/vehicles', { body });
      await loadCars();
      pickCar(saved.id);
      toast(v ? 'Saved.' : 'Vehicle added. Connecting to its footage…');
      go('#/settings/vehicles');
    });
  };
  form.querySelector('#v-del')?.addEventListener('click', async (e) => {
    if (!(await ask({ title: `Remove ${v.name}?`, body: '<p>The manager forgets the vehicle and unmounts its share. No footage is deleted. This asks for your password.</p>', yes: 'Remove vehicle', danger: true }))) return;
    await act(e.target, async () => {
      await api(`/api/vehicles/${encodeURIComponent(v.id)}`, { method: 'DELETE' });
      await loadCars();
      toast('Vehicle removed.');
      go('#/settings/vehicles');
    });
  });
}
function carForm(v) {
  const versions = system?.smbVersions || { '3.1.1': 'SMB 3.1.1 (recommended)', '3.02': 'SMB 3.02', '3.0': 'SMB 3.0', 3: 'SMB 3.0 or newer' };
  const s = v?.source || { type: 'smb', version: system?.smbDefaultVersion || '3.1.1', encrypt: true };
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return `<form class="panel hud orange form" id="v-form" novalidate>
    ${panelHead(`${ico(v ? 'gear' : 'plus')}${v ? `Edit ${h(v.name)}` : 'Add a vehicle'}`)}
    <div class="grid2">
      <label class="fld">Name<input class="in" name="name" required value="${h(v?.name || '')}" placeholder="Daily driver"></label>
      <label class="fld">Time zone<input class="in" name="timezone" value="${h(v?.timezone || tz)}" placeholder="America/Chicago" autocapitalize="none" spellcheck="false"></label>
    </div>
    <div class="fld">Footage source${segs('src', [['smb', 'SMB share'], ['path', 'Folder in the container']], s.type === 'path' ? 'path' : 'smb', 'Footage source')}</div>
    <div data-src="smb" class="form"${s.type === 'path' ? ' hidden' : ''}>
      <div class="grid2">
        <label class="fld span-all">Share<input class="in mono" name="share" value="${h(s.share || '')}" placeholder="//192.168.1.50/TeslaCam" spellcheck="false" autocapitalize="none"></label>
        <label class="fld">User name<input class="in" name="username" value="${h(s.username || '')}" autocomplete="off" autocapitalize="none"></label>
        <label class="fld">Password<input class="in" name="password" type="password" placeholder="${s.passwordSet ? 'saved · leave empty to keep' : ''}" autocomplete="new-password"></label>
        <label class="fld">Domain (optional)<input class="in" name="domain" value="${h(s.domain || '')}" autocapitalize="none"></label>
        <label class="fld">SMB version<select class="in" name="version">${Object.entries(versions).map(([x, l]) => `<option value="${h(x)}"${String(s.version || '3.1.1') === x ? ' selected' : ''}>${h(l)}</option>`).join('')}</select></label>
        <label class="fld">Port (optional)<input class="in num" name="port" inputmode="numeric" value="${h(s.port || '')}" placeholder="445"></label>
        <label class="chk span-all"><input type="checkbox" name="encrypt"${s.encrypt === false ? '' : ' checked'}> Encrypt the connection (recommended). Without it the connection is still signed.</label>
      </div>
      <p class="small faint">SMB 3 only, every connection signed. Use a NAS account that can reach this share only.</p>
    </div>
    <div data-src="path" class="form"${s.type === 'path' ? '' : ' hidden'}>
      <label class="fld">Folder<input class="in mono" name="path" value="${h(s.path || '')}" placeholder="/footage/weekend-car" spellcheck="false" autocapitalize="none"></label>
      <p class="small faint">A folder mounted into the container (a bind mount or a Docker CIFS volume).</p>
    </div>
    <p class="small faint">Adding a vehicle or changing where its footage comes from asks for your password.</p>
    <div class="row">${v ? `<button class="btn danger" type="button" id="v-del">${ico('bin')}Remove vehicle…</button>` : ''}<a class="btn" href="#/settings/vehicles">Cancel</a><button class="btn go" type="submit">${v ? 'Save' : 'Add vehicle'}</button></div>
  </form>`;
}

// ---------- account ----------
async function account(box) {
  const me = await api('/api/auth/me').catch(() => ({}));
  box.innerHTML = `<form class="panel hud form" id="pw">
    ${panelHead(`${ico('lock')}Account`, `<span class="small dim">signed in as <b class="mono">${h(me.user || '')}</b></span>`)}
    <input type="text" name="username" autocomplete="username" value="${h(me.user || '')}" hidden>
    <div class="grid2">
      <label class="fld">Current password<input class="in" type="password" name="current" autocomplete="current-password" required></label>
      <label class="fld">New password<input class="in" type="password" name="next" autocomplete="new-password" minlength="8" required></label>
    </div>
    <p class="small faint">At least 8 characters. Every other signed-in browser is signed out.</p>
    <div class="row"><button class="btn go" type="submit">Change password</button><button class="btn" type="button" id="out">${ico('logout')}Sign out</button></div></form>`;
  box.querySelector('#pw').onsubmit = (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    if (String(fd.get('next')).length < 8) { toast('Choose a new password of at least 8 characters.', 'bad'); return; }
    act(e.target.querySelector('[type=submit]'), async () => {
      await api('/api/auth/password', { body: { current: fd.get('current'), next: fd.get('next') } });
      e.target.reset();
      toast('Password changed. Other sessions were signed out.');
    });
  };
  box.querySelector('#out').onclick = async () => {
    await api('/api/auth/logout', { body: {} }).catch(() => {});
    location.href = '/login';
  };
}

// ---------- interface (UI packs) ----------
async function iface(box) {
  const ui = await api('/api/ui-packs');
  const activeName = ui.packs.find((x) => x.id === ui.active)?.name;
  box.innerHTML = `<section class="panel hud cyan">
    ${panelHead(`${ico('horizon')}Interface`, pill(ui.active ? activeName || 'pack' : 'Original', 'mag'))}
    <p class="small dim">How Sentry Six Manager looks and works for everyone who signs in. <b>Original</b> is the built-in interface; the others are packs you uploaded.</p>
    ${ui.original ? `<div class="note org" style="margin-top:10px">This browser shows the original interface because you opened <span class="mono">/original</span>${ui.active ? `; everyone else sees <b>${h(activeName || '')}</b>` : ''}. <a href="/original?off=1">Show the chosen interface</a></div>` : ''}
    <label class="fld" style="max-width:420px;margin-top:12px">Interface for everyone<select class="in" id="ui-pick"><option value=""${ui.active ? '' : ' selected'}>Original (built-in)</option>${ui.packs.map((x) => `<option value="${h(x.id)}"${x.id === ui.active ? ' selected' : ''}>${h(x.name)}</option>`).join('')}</select></label>
    ${ui.packs.length ? `<ul class="packs">${ui.packs.map((x) => `<li class="pack"><div class="grow"><b>${h(x.name)}</b> ${x.id === ui.active ? pill('in use', 'grn') : ''}${x.description ? `<p class="small dim">${h(x.description)}</p>` : ''}<p class="small faint">${x.author ? `by ${h(x.author)} · ` : ''}${h((x.replaces || []).map((k) => (k === 'web' ? 'pages' : 'Studio pages')).join(', '))} · ${h(x.files)} files · ${size(x.bytes)} · uploaded ${h(stampFull(Date.parse(x.uploadedAt)))}</p></div>
      <div class="row">${x.id === ui.active ? '' : `<button class="btn sm" type="button" data-use="${h(x.id)}">Use</button>`}<button class="btn sm danger" type="button" data-del="${h(x.id)}">${ico('bin')}Delete</button></div></li>`).join('')}</ul>` : ''}
    <div class="row" style="margin-top:12px">
      <input type="file" id="ui-file" accept=".zip,application/zip" class="sr-only">
      <label class="btn go" for="ui-file">${ico('upload')}Upload a pack (.zip)</label>
      <a class="btn" href="/api/ui-packs/original.zip" download>${ico('download')}Download the original to start from</a>
    </div>
    <p class="small faint" style="margin-top:10px">A pack replaces built-in files with the same path. <b>Its scripts run as whoever is signed in and can do anything you can</b>: only upload packs you made or trust. Uploading or choosing one asks for your password.</p>
    <p class="small faint">If a pack ever breaks the pages, open <a class="mono" href="/original">${h(location.origin)}/original</a>: that browser then shows the original interface, and you can switch back here.</p>
  </section>`;
  const use = async (id) => {
    await api('/api/ui-packs/active', { method: 'PUT', body: { id } });
    toast('Switching the interface…');
    location.reload();
  };
  box.querySelector('#ui-pick').onchange = async (e) => {
    try { await use(e.target.value || null); } catch (err) { e.target.value = ui.active || ''; toast(err.message, 'bad'); }
  };
  box.querySelectorAll('[data-use]').forEach((b) => { b.onclick = () => act(b, () => use(b.dataset.use)); });
  box.querySelectorAll('[data-del]').forEach((b) => {
    b.onclick = async () => {
      const x = ui.packs.find((p) => p.id === b.dataset.del);
      if (!(await ask({ title: 'Delete this interface?', body: `<p><b>${h(x?.name || '')}</b> is deleted from the server.${x?.id === ui.active ? ' Everyone gets the original interface.' : ''}</p>`, yes: 'Delete', danger: true }))) return;
      await act(b, async () => {
        await api(`/api/ui-packs/${encodeURIComponent(x.id)}`, { method: 'DELETE' });
        if (x.id === ui.active) location.reload(); else iface(box);
      });
    };
  });
  const file = box.querySelector('#ui-file');
  file.onchange = async () => {
    const f = file.files[0];
    file.value = '';
    if (!f) return;
    try {
      const data = await send('/api/ui-packs/upload', f, { 'Content-Type': 'application/zip', 'X-File-Name': encodeURIComponent(f.name) });
      if (await ask({ title: 'Use it now?', body: `<p><b>${h(data.pack.name)}</b> is installed (${h(data.pack.files)} files). Use it for everyone now? You can switch back to Original here any time.</p>`, yes: 'Use it' })) await use(data.pack.id);
      else iface(box);
    } catch (err) { toast(err.message, 'bad'); }
  };
}

// ---------- background effect and motion ----------
async function display(box) {
  const s = await api('/api/settings').catch(() => ({}));
  const calm = Boolean(s.appearance?.reduceEffects);
  const sky = window.HorizonSky;
  const choice = sky?.choice || 'auto';
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
  box.innerHTML = `<section class="panel hud form">
    ${panelHead(`${ico('hud')}Background effect`, pill(`running: ${sky?.mode || '—'}`, 'cyan'))}
    <p class="small dim">The neon grid and the setting sun behind every page. Saved in this browser only.</p>
    ${segs('sky', [['auto', 'Auto'], ['full', 'Full'], ['calm', 'Calm'], ['off', 'Off']], choice, 'Background effect')}
    <ul class="small dim legend-l">
      <li><b>Auto</b>: Full on computers and tablets, Calm on phones.</li>
      <li><b>Full</b>: the grid scrolls toward the sun (at most 30 frames a second) and speeds up while a conversion runs.</li>
      <li><b>Calm</b>: the grid drifts slowly at 12 frames a second, for slower devices.</li>
      <li><b>Off</b>: a plain dusk gradient, nothing drawn.</li>
    </ul>
    ${reduced ? '<p class="note">Your device asks for reduced motion, so the background shows a still picture whatever you pick here.</p>' : ''}
    <p class="small faint">The effect always stops while the tab is hidden and while a video plays in the Viewer.</p>
  </section>
  <section class="panel hud form">
    ${panelHead(`${ico('gear')}Motion for everyone`)}
    <label class="chk"><input type="checkbox" id="calm"${calm ? ' checked' : ''}> Reduce effects for everyone (no page animations; saved on the server)</label>
    <label class="chk"><input type="checkbox" id="units"${local.get('vw.units', 'mph') === 'kmh' ? ' checked' : ''}> Show speed in km/h in the Viewer (this browser)</label>
    <p class="small faint">Keyboard: press <kbd>?</kbd> anywhere for the shortcuts, <kbd>[</kbd> and <kbd>]</kbd> tune to the previous and next page.</p>
  </section>`;
  onSegs(box, 'sky', (m) => {
    sky?.setChoice(m);
    box.querySelector('.ph .pill').textContent = `running: ${sky?.mode || '—'}`;
    toast(`Background effect: ${m}.`);
  });
  box.querySelector('#calm').onchange = (e) => act(null, async () => {
    await api('/api/settings/appearance', { method: 'PUT', body: { reduceEffects: e.target.checked } });
    document.documentElement.classList.toggle('calm-ui', e.target.checked);
    toast('Saved.');
  });
  box.querySelector('#units').onchange = (e) => { local.set('vw.units', e.target.checked ? 'kmh' : 'mph'); toast('Saved.'); };
}

// ---------- updates ----------
async function updates(box) {
  const u = await api('/api/updates');
  const cur = u.current || {};
  const running = `${cur.sha ? `${cur.sha.slice(0, 7)}${u.tag ? ` (${u.tag})` : ''}` : 'built from source'}${cur.builtAt ? ` · built ${String(cur.builtAt).slice(0, 10)}` : ''}`;
  const l = u.latest;
  box.innerHTML = `<section class="panel hud">${panelHead(`${ico('download')}Updates`, u.updateAvailable ? pill('update available', 'grn') : '')}
    <p class="small dim">${u.enabled ? 'Updates come as a new image. To install one, run <code>docker compose pull &amp;&amp; docker compose up -d</code> where you set up Sentry Six Manager. Settings, footage and the Recycle Bin stay.' : u.image ? 'Checking for updates is turned off (UPDATE_CHECK=off). To update, run <code>docker compose pull &amp;&amp; docker compose up -d</code>.' : 'This copy was built from source. To update it, build the image again from the new code.'}</p>
    <dl class="kv" style="margin-top:12px"><dt>Running</dt><dd class="mono">${h(running)}</dd>${u.image ? `<dt>Image</dt><dd class="mono">${h(u.image)}</dd>` : ''}
      ${u.enabled ? `<dt>Newest</dt><dd class="mono">${l ? h(`${l.revision ? `${l.revision.slice(0, 7)} · ` : ''}published ${String(l.created || '').slice(0, 10)}`) : h(u.error || 'not checked yet')}</dd><dt>Checked</dt><dd>${h(stampFull(u.checkedAt))}</dd>` : ''}</dl>
    ${u.enabled ? `<div class="row" style="margin-top:12px"><button class="btn" type="button" id="upd">${ico('refresh')}Check now</button></div>` : ''}</section>`;
  box.querySelector('#upd')?.addEventListener('click', (e) => act(e.currentTarget, async () => {
    const out = await api('/api/updates/check', { body: {} });
    toast(out.error || (out.updateAvailable ? 'An update is available.' : 'This is the newest version.'), out.error ? 'bad' : 'ok');
    updates(box);
  }));
}

// ---------- security ----------
async function security(box) {
  const sec = await api('/api/security');
  const tls = sec.tls || {};
  const host = (sec.currentHost || '').replace(/:\d+$/, '').replace(/^\[|\]$/g, '');
  const covered = !host || (tls.hostnames || []).map((x) => x.toLowerCase()).includes(host.toLowerCase());
  const fp = (s) => h(s || '?').replace(/:/g, ':<wbr>');
  let body = `<dl class="kv"><dt>This connection</dt><dd>${sec.https ? 'HTTPS (encrypted)' : '<b class="badtx">not encrypted</b>: use https:// or a reverse proxy that does HTTPS.'}</dd>
    <dt>Server process</dt><dd>${sec.runningAsRoot ? 'runs as root (not supervised; fine for development, not for the Docker image)' : 'runs as an unprivileged user'}</dd>`;
  if (sec.tlsMode === 'off') body += '<dt>HTTPS</dt><dd>turned off (TLS_MODE=off): only behind a reverse proxy that does HTTPS.</dd></dl>';
  else if (tls.mode === 'own') body += `<dt>Certificate</dt><dd>your own (TLS_CERT_FILE) · valid until ${h(tls.certificate?.validTo || '?')}</dd><dt>Fingerprint</dt><dd class="mono small">${fp(tls.certificate?.fingerprint)}</dd></dl>`;
  else if (tls.error) body += `<dt>Certificate</dt><dd>${h(tls.error)}</dd></dl>`;
  else {
    body += `<dt>Certificate SHA-256</dt><dd class="mono small">${fp(tls.certificate?.fingerprint)}</dd><dt>Valid until</dt><dd>${h(tls.certificate?.validTo || '?')} (renews by itself)</dd>
      <dt>Covers</dt><dd class="mono small">${h((tls.hostnames || []).join(', '))}</dd><dt>Certificate authority</dt><dd>valid until ${h(tls.ca?.validTo || '?')} · <span class="mono small">${fp(tls.ca?.fingerprint)}</span></dd></dl>
      ${covered ? '' : `<div class="note org" style="margin-top:10px">You opened this page as <b>${h(host)}</b>, which the certificate does not cover. <button class="btn sm" type="button" id="sec-add" data-host="${h(host)}">Add ${h(host)}</button></div>`}
      <p class="small dim" style="margin-top:12px">Every device shows the browser's certificate warning once. To avoid it, install the certificate authority on the device (compare its fingerprint first). It can only vouch for local names and private addresses.</p>
      <details class="arch"><summary>How to install the certificate authority</summary><ul class="small dim legend-l">
        <li><b>iPhone / iPad:</b> open the download in Safari, install it in Settings › General › VPN &amp; Device Management, then turn on full trust in Settings › General › About › Certificate Trust Settings.</li>
        <li><b>Android:</b> Settings › Security › Encryption &amp; credentials › Install a certificate › CA certificate.</li>
        <li><b>Windows:</b> open the file › Install Certificate › Local Machine › Trusted Root Certification Authorities.</li>
        <li><b>macOS:</b> open it in Keychain Access (System) and set Trust to Always Trust.</li></ul></details>
      <form id="sec-hosts" class="form" style="margin-top:12px">
        <label class="fld">Extra names and addresses for the certificate<input class="in mono" name="hostnames" value="${h((tls.editable || []).join(', '))}" placeholder="192.168.1.20, nas.local" spellcheck="false" autocapitalize="none"></label>
        <p class="small faint">Names from TLS_HOSTNAMES: ${h((tls.fromEnv || []).join(', ') || 'none')}. Saving makes a new certificate and asks for your password.</p>
        <div class="row"><a class="btn" href="/api/security/ca.crt" download>${ico('download')}Download certificate authority</a><button class="btn go" type="submit">Save names</button></div>
      </form>`;
  }
  box.innerHTML = `<section class="panel hud">${panelHead(`${ico('shield')}Security`, sec.https ? pill('HTTPS', 'grn') : pill('plain HTTP', 'red'))}${body}</section>`;
  const save = async (names) => {
    if (!(await ask({ title: 'Make a new certificate?', body: "<p>The certificate will cover the new names. Devices that went past the browser's warning see it once more.</p>", yes: 'Save names' }))) return;
    await act(null, async () => {
      const out = await api('/api/security/hostnames', { method: 'PUT', body: { hostnames: names } });
      toast(`${out.caReplaced ? 'Saved. The certificate authority was replaced.' : 'Saved.'} Reloading for the new certificate…`);
      setTimeout(() => location.reload(), 2500);
    });
  };
  box.querySelector('#sec-hosts')?.addEventListener('submit', (e) => {
    e.preventDefault();
    save(String(new FormData(e.target).get('hostnames') || '').split(/[\s,]+/).filter(Boolean));
  });
  box.querySelector('#sec-add')?.addEventListener('click', (e) => save([...(tls.editable || []), e.currentTarget.dataset.host]));
}

// ---------- system ----------
async function sys(box) {
  const [s, st] = await Promise.all([api('/api/system'), api('/api/stats').catch(() => ({}))]);
  system = s;
  const dataVol = (st.filesystems || []).find((f) => !f.vehicle)?.path;
  const caps = s.converter?.capabilities || {};
  const gpus = [...(s.gpu?.nvidia || []).map((g) => `${g.name} (driver ${g.driver})`), ...(s.gpu?.gpus || []).filter((g) => g.vendor !== 'nvidia').map((g) => `${g.name || g.vendorName} · ${g.node}${g.virtual ? ' · not a GPU' : g.passedThrough ? (g.encodes ? ` · encodes ${Object.entries(g.encodes).filter(([, x]) => x).map(([k]) => k.toUpperCase()).join(', ') || 'nothing'}` : '') : ' · not passed into the container'}`)];
  box.innerHTML = `<section class="panel hud">${panelHead(`${ico('info')}System`)}<dl class="kv">
    <dt>Version</dt><dd class="mono">${h(st.host?.version || s.version?.sha || 'dev')}</dd>
    <dt>Converter</dt><dd>${s.converter?.ready ? `ready · replace originals ${h(caps.replacement)} · cleanup ${h(caps.ownershipCleanup)} · publication ${h(caps.separatePublication)}` : `not ready (${h(s.converter?.error || 'starting')})`}</dd>
    <dt>Safe rename helper</dt><dd>${s.nativeHelper ? 'installed' : 'missing (link + unlink fallback)'}</dd>
    <dt>GPUs</dt><dd>${gpus.length ? gpus.map(h).join('<br>') : 'none visible (the CPU encoders are used)'}</dd>
    ${(s.gpu?.hints || []).length ? `<dt>GPU hints</dt><dd class="small">${s.gpu.hints.map(h).join('<br>')}</dd>` : ''}
    <dt>Data volume free</dt><dd class="num">${size(s.dataFree)}</dd>
    <dt>Data volume</dt><dd class="mono small">${h(dataVol || '—')}</dd><dt>Converted copies</dt><dd class="mono small">${h(dataVol ? `${dataVol}/converted` : '—')}</dd>
    <dt>Server time zone</dt><dd>${h(s.timezone)}</dd>
    <dt>HTTPS</dt><dd>${s.security?.https ? 'on' : 'off'} · TLS mode ${h(s.security?.tlsMode)} · ${s.security?.supervised ? 'supervised' : 'not supervised'}${ok(s.security?.uid) ? ` · uid ${s.security.uid}` : ''}</dd>
  </dl></section>`;
}

// ---------- electricity ----------
async function power(box) {
  const s = await api('/api/settings');
  const p = s.power || { currency: '$', mode: 'flat', rates: [] };
  let mode = p.mode === 'tou' ? 'tou' : 'flat';
  const rateRow = (r = {}) => {
    const days = new Set(Array.isArray(r.days) ? r.days : [0, 1, 2, 3, 4, 5, 6]);
    return `<div class="rate" data-rate>
      <label class="fld">Name<input class="in" data-k="label" maxlength="24" value="${h(r.label || '')}" placeholder="Off-peak"></label>
      <label class="fld">Price per kWh<input class="in num" data-k="price" inputmode="decimal" value="${ok(r.price) ? r.price : ''}" placeholder="0.12"></label>
      <label class="fld">From<input class="in num" type="time" data-k="from" value="${h(r.from || '23:00')}"></label>
      <label class="fld">To<input class="in num" type="time" data-k="to" value="${h(r.to || '07:00')}"></label>
      <fieldset class="days"><legend class="small dim">Days</legend>${WEEK.map(([d, n]) => `<label class="day"><input type="checkbox" value="${d}"${days.has(d) ? ' checked' : ''}><span>${n}</span></label>`).join('')}</fieldset>
      <button class="btn sm ghost" type="button" data-rdel>${ico('x')}Remove rate</button></div>`;
  };
  box.innerHTML = `<form class="panel hud form" id="pp" novalidate>
    ${panelHead(`${ico('bolt')}Electricity price`)}
    <p class="small dim">For the costs next to energy on the Dashboard, the Encoder and Jobs, and for "off-peak only" automatic conversion. Leave it empty to see energy only.</p>
    <div class="fld">Plan${segs('pm', [['flat', 'One price'], ['tou', 'Time of use']], mode, 'Plan')}</div>
    <div class="grid2">
      <label class="fld">Currency<input class="in" name="currency" maxlength="3" value="${h(p.currency || '$')}"></label>
      <label class="fld" data-plan="flat"${mode === 'flat' ? '' : ' hidden'}>Price per kWh<input class="in num" name="pricePerKwh" inputmode="decimal" value="${ok(p.pricePerKwh) ? p.pricePerKwh : ''}" placeholder="0.15"></label>
      <label class="fld" data-plan="tou"${mode === 'tou' ? '' : ' hidden'}>Other hours (per kWh)<input class="in num" name="defaultPrice" inputmode="decimal" value="${ok(p.defaultPrice) ? p.defaultPrice : ''}" placeholder="0.25"></label>
    </div>
    <div data-plan="tou" class="form"${mode === 'tou' ? '' : ' hidden'}>
      <p class="small faint">Rates in order: the first whose days and hours match wins. 23:00 to 07:00 runs over midnight. Server time${system?.timezone ? ` (${h(system.timezone)})` : ''}.</p>
      <div class="rates" id="rates">${(p.rates || []).map(rateRow).join('')}</div>
      <div><button class="btn sm" type="button" id="radd">${ico('plus')}Add a rate</button></div>
    </div>
    <div class="row"><button class="btn go" type="submit">Save price</button></div></form>`;
  const form = box.querySelector('#pp');
  const list = box.querySelector('#rates');
  onSegs(form, 'pm', (m) => {
    mode = m;
    form.querySelectorAll('[data-plan]').forEach((n) => { n.hidden = n.dataset.plan !== m; });
    if (m === 'tou' && !list.children.length) list.insertAdjacentHTML('beforeend', rateRow({ label: 'Off-peak' }));
  });
  box.querySelector('#radd').onclick = () => {
    if (list.children.length >= 12) return;
    list.insertAdjacentHTML('beforeend', rateRow(list.children.length ? { label: 'Peak', from: '16:00', to: '21:00', days: [1, 2, 3, 4, 5] } : { label: 'Off-peak' }));
  };
  list.addEventListener('click', (e) => { e.target.closest('[data-rdel]')?.closest('[data-rate]').remove(); });
  form.onsubmit = (e) => {
    e.preventDefault();
    const fd = new FormData(form);
    const n = (x) => (String(x ?? '').trim() === '' ? null : Number(String(x).replace(',', '.')));
    const rates = [...list.querySelectorAll('[data-rate]')].map((row) => {
      const g = (k) => row.querySelector(`[data-k="${k}"]`).value;
      return { label: g('label').trim(), price: n(g('price')), from: g('from'), to: g('to'), days: [...row.querySelectorAll('.days input:checked')].map((x) => Number(x.value)) };
    });
    const body = { currency: String(fd.get('currency') || '').trim() || '$', mode, pricePerKwh: n(fd.get('pricePerKwh')), defaultPrice: n(fd.get('defaultPrice')), rates: mode === 'tou' ? rates : (p.rates || []) };
    if ([body.pricePerKwh, body.defaultPrice, ...rates.map((r) => r.price)].some(Number.isNaN)) { toast('Type prices as numbers, like 0.15.', 'bad'); return; }
    act(form.querySelector('[type=submit]'), async () => {
      app.power = await api('/api/settings/power', { method: 'PUT', body });
      toast('Saved. Costs follow this price from now on.');
    });
  };
}
