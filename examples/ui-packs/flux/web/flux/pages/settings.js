// Settings: vehicles, account, interface (UI packs), updates, security, system, power, appearance.
import { esc, api, upload, state, current, setVehicle, loadVehicles, bytes, isoish, icon, toast, confirmDialog, busy, fin, store } from '../core.js';
import { seg, wireSeg, chip } from '../ui.js';

const TABS = [['vehicles', 'Vehicles'], ['account', 'Account'], ['interface', 'Interface'], ['updates', 'Updates'], ['security', 'Security'], ['system', 'System'], ['power', 'Electricity'], ['appearance', 'Appearance']];
const WEEK = [[1, 'Mon'], [2, 'Tue'], [3, 'Wed'], [4, 'Thu'], [5, 'Fri'], [6, 'Sat'], [0, 'Sun']];

export default {
  async mount(el, { sub, params, go }) {
    const tab = TABS.some(([k]) => k === sub.split('/')[0]) ? sub.split('/')[0] : 'vehicles';
    el.innerHTML = `<div class="phead"><div><h1>Settings</h1></div></div>
      <div class="settings">
        <nav class="stabs" aria-label="Settings sections">${TABS.map(([k, l]) => `<a href="#/settings/${k}" class="${k === tab ? 'on' : ''}"${k === tab ? ' aria-current="page"' : ''}>${l}</a>`).join('')}</nav>
        <div class="spanel" id="sp"><div class="loading"><i></i><i></i><i></i></div></div>
      </div>`;
    const box = el.querySelector('#sp');
    const sections = { vehicles, account, interface: iface, updates, security, system, power, appearance };
    await sections[tab](box, { params, go });
    return {
      onTopics(t) {
        if (tab === 'vehicles' && t.includes('vehicles') && !box.querySelector('#veh-form')) vehicles(box, { params: new URLSearchParams(), go });
      }
    };
  }
};

// ---------- vehicles ----------
async function vehicles(box, { params, go }) {
  if (!state.system) state.system = await api('/api/system').catch(() => null);
  const editId = params.get('edit');
  const adding = params.get('add') === '1';
  const v = editId ? state.vehicles.find((x) => x.id === editId) : null;
  box.innerHTML = `<section class="card"><header class="card-h"><h2>Vehicles</h2><a class="btn primary" href="#/settings/vehicles?add=1">${icon('plus')}Add vehicle</a></header>
    <div class="tscroll"><table class="dtable stack"><thead><tr><th>name</th><th>footage source</th><th>status</th><th class="r">actions</th></tr></thead><tbody>
    ${state.vehicles.map((x) => `<tr><td><b>${esc(x.name)}</b><div class="faint small">${esc(x.timezone)} · <span class="mono">${esc(x.id)}</span></div></td>
      <td class="small"><span class="mono wrap">${esc(x.source.type === 'smb' ? x.source.share : x.source.path)}</span>${x.security ? `<div class="faint">${esc(x.security)}</div>` : ''}</td>
      <td>${x.share?.healthy ? (x.share.writable === false ? chip('read-only', 'amber') : chip('connected', 'green')) : chip('unavailable', 'red')}${x.share?.lastError ? `<div class="small bad-text">${esc(x.share.lastError)}</div>` : ''}</td>
      <td class="r nowrap"><button class="btn sm" type="button" data-scan="${esc(x.id)}">${icon('refresh')}Scan</button><button class="btn sm" type="button" data-recon="${esc(x.id)}">Reconnect</button><a class="btn sm" href="#/settings/vehicles?edit=${encodeURIComponent(x.id)}">Edit</a></td></tr>`).join('') || '<tr><td colspan="4" class="muted">No vehicles yet.</td></tr>'}
    </tbody></table></div></section>
    ${adding || v ? vehicleForm(v) : ''}`;
  box.querySelectorAll('[data-scan]').forEach((b) => { b.onclick = () => busy(b, async () => { await api(`/api/vehicles/${encodeURIComponent(b.dataset.scan)}/scan`, { body: {} }); toast('Scanning… Jobs shows the progress.'); }); });
  box.querySelectorAll('[data-recon]').forEach((b) => { b.onclick = () => busy(b, async () => { const out = await api(`/api/vehicles/${encodeURIComponent(b.dataset.recon)}/reconnect`, { body: {} }); toast(out.share?.healthy === false ? `Still unavailable: ${out.share.lastError || ''}` : 'Reconnected.'); await loadVehicles(); }); });
  const form = box.querySelector('#veh-form');
  if (!form) return;
  form.scrollIntoView({ block: 'start' });
  let type = v?.source?.type === 'path' ? 'path' : (v ? 'smb' : 'smb');
  wireSeg(form, 'srctype', (t) => {
    type = t;
    form.querySelectorAll('[data-src]').forEach((n) => { n.hidden = n.dataset.src !== t; });
  });
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
      // only send the source when it changed, so a rename needs no password
      const was = v.source || {};
      const same = type === was.type && (type === 'path' ? body.source.path === was.path
        : ['share', 'username', 'domain', 'version'].every((k) => String(body.source[k] ?? '') === String(was[k] ?? '')) && body.source.encrypt === (was.encrypt !== false) && String(body.source.port ?? '') === String(was.port ?? '') && !body.source.password);
      if (same) delete body.source;
    }
    busy(form.querySelector('[type=submit]'), async () => {
      const saved = v ? await api(`/api/vehicles/${encodeURIComponent(v.id)}`, { method: 'PUT', body }) : await api('/api/vehicles', { body });
      await loadVehicles();
      setVehicle(saved.id);
      toast(v ? 'Saved.' : 'Vehicle added. Connecting to its footage…');
      go('#/settings/vehicles');
    });
  };
  form.querySelector('#veh-del')?.addEventListener('click', async (e) => {
    if (!(await confirmDialog({ title: `Remove ${v.name}?`, body: '<p>The manager forgets the vehicle and unmounts its share. No footage is deleted. This asks for your password.</p>', ok: 'Remove vehicle', danger: true }))) return;
    await busy(e.target, async () => {
      await api(`/api/vehicles/${encodeURIComponent(v.id)}`, { method: 'DELETE' });
      await loadVehicles();
      toast('Vehicle removed.');
      go('#/settings/vehicles');
    });
  });
}

function vehicleForm(v) {
  const versions = state.system?.smbVersions || { '3.1.1': 'SMB 3.1.1 (recommended)', '3.02': 'SMB 3.02', '3.0': 'SMB 3.0', 3: 'SMB 3.0 or newer' };
  const s = v?.source || { type: 'smb', version: state.system?.smbDefaultVersion || '3.1.1', encrypt: true };
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return `<form class="card form-card" id="veh-form" novalidate>
    <header class="card-h"><h2>${v ? `Edit ${esc(v.name)}` : 'Add a vehicle'}</h2></header>
    <div class="grid2">
      <label class="field">Name<input class="input" name="name" required value="${esc(v?.name || '')}" placeholder="Daily driver"></label>
      <label class="field">Time zone<input class="input" name="timezone" value="${esc(v?.timezone || tz)}" placeholder="America/Chicago"></label>
    </div>
    <div class="field">Footage source${seg('srctype', [['smb', 'SMB share'], ['path', 'Folder in the container']], s.type === 'path' ? 'path' : 'smb', 'Footage source')}</div>
    <div data-src="smb"${s.type === 'path' ? ' hidden' : ''}>
      <div class="grid2">
        <label class="field span2">Share<input class="input mono" name="share" value="${esc(s.share || '')}" placeholder="//192.168.1.50/TeslaCam" spellcheck="false"></label>
        <label class="field">User name<input class="input" name="username" value="${esc(s.username || '')}" autocomplete="off"></label>
        <label class="field">Password<input class="input" name="password" type="password" placeholder="${s.passwordSet ? 'saved · leave empty to keep' : ''}" autocomplete="new-password"></label>
        <label class="field">Domain (optional)<input class="input" name="domain" value="${esc(s.domain || '')}"></label>
        <label class="field">SMB version<select class="input" name="version">${Object.entries(versions).map(([x, l]) => `<option value="${esc(x)}"${String(s.version || '3.1.1') === x ? ' selected' : ''}>${esc(l)}</option>`).join('')}</select></label>
        <label class="field">Port (optional)<input class="input num" name="port" inputmode="numeric" value="${esc(s.port || '')}" placeholder="445"></label>
        <label class="check span2"><input type="checkbox" name="encrypt"${s.encrypt === false ? '' : ' checked'}> Encrypt the connection (recommended). Without it the connection is still signed.</label>
      </div>
      <p class="faint small">SMB 3 only, every connection signed. Use a NAS account with access to this share only.</p>
    </div>
    <div data-src="path"${s.type === 'path' ? '' : ' hidden'}>
      <label class="field">Folder<input class="input mono" name="path" value="${esc(s.path || '')}" placeholder="/footage/weekend-car" spellcheck="false"></label>
      <p class="faint small">A folder mounted into the container (bind mount or Docker CIFS volume).</p>
    </div>
    <p class="faint small">Adding a vehicle or changing where its footage comes from asks for your password.</p>
    <div class="row-actions">${v ? '<button class="btn danger" type="button" id="veh-del">Remove vehicle…</button>' : ''}<a class="btn" href="#/settings/vehicles">Cancel</a><button class="btn primary" type="submit">${v ? 'Save' : 'Add vehicle'}</button></div>
  </form>`;
}

// ---------- account ----------
async function account(box) {
  const me = await api('/api/auth/me').catch(() => ({}));
  box.innerHTML = `<form class="card form-card" id="pw-form">
    <header class="card-h"><h2>Account</h2><span class="faint small">signed in as <b class="mono">${esc(me.user || '')}</b></span></header>
    <div class="grid2">
      <label class="field">Current password<input class="input" type="password" name="current" autocomplete="current-password" required></label>
      <label class="field">New password<input class="input" type="password" name="next" autocomplete="new-password" minlength="8" required></label>
    </div>
    <p class="faint small">At least 8 characters. Every other signed-in browser is signed out.</p>
    <div class="row-actions"><button class="btn" type="button" id="signout">${icon('logout')}Sign out</button><button class="btn primary" type="submit">Change password</button></div></form>`;
  box.querySelector('#pw-form').onsubmit = (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    if (String(fd.get('next')).length < 8) { toast('Choose a new password of at least 8 characters.', 'bad'); return; }
    busy(e.target.querySelector('[type=submit]'), async () => {
      await api('/api/auth/password', { body: { current: fd.get('current'), next: fd.get('next') } });
      e.target.reset();
      toast('Password changed. Other sessions were signed out.');
    });
  };
  box.querySelector('#signout').onclick = async () => {
    await api('/api/auth/logout', { body: {} }).catch(() => {});
    location.href = '/login';
  };
}

// ---------- interface ----------
async function iface(box) {
  const ui = await api('/api/ui-packs');
  const activeName = ui.packs.find((x) => x.id === ui.active)?.name;
  box.innerHTML = `<section class="card">
    <header class="card-h"><h2>Interface</h2>${chip(ui.active ? activeName || 'pack' : 'Original', 'violet')}</header>
    <p class="small muted">How Sentry Six Manager looks and works for everyone who signs in. <b>Original</b> is the built-in interface; the others are packs you uploaded.</p>
    ${ui.original ? `<div class="note amber small">This browser shows the original interface because you opened <span class="mono">/original</span>${ui.active ? `; everyone else sees <b>${esc(activeName || '')}</b>` : ''}. <a href="/original?off=1">Show the chosen interface</a></div>` : ''}
    <label class="field narrow">Interface for everyone<select class="input" id="ui-pick"><option value=""${ui.active ? '' : ' selected'}>Original (built-in)</option>${ui.packs.map((x) => `<option value="${esc(x.id)}"${x.id === ui.active ? ' selected' : ''}>${esc(x.name)}</option>`).join('')}</select></label>
    ${ui.packs.length ? `<div class="tscroll"><table class="dtable stack"><thead><tr><th>pack</th><th>changes</th><th>uploaded</th><th class="r"></th></tr></thead><tbody>${ui.packs.map((x) => `<tr><td><b>${esc(x.name)}</b>${x.id === ui.active ? ` ${chip('in use', 'green')}` : ''}${x.description ? `<div class="small muted">${esc(x.description)}</div>` : ''}${x.author ? `<div class="small faint">by ${esc(x.author)}</div>` : ''}</td>
      <td class="small">${esc((x.replaces || []).map((k) => (k === 'web' ? 'pages' : 'Studio pages')).join(', '))} · ${x.files} files · ${bytes(x.bytes)}</td><td class="small num">${esc(isoish(Date.parse(x.uploadedAt)))}</td>
      <td class="r nowrap">${x.id === ui.active ? '' : `<button class="btn sm" type="button" data-use="${esc(x.id)}">Use</button>`}<button class="btn sm danger" type="button" data-del="${esc(x.id)}">Delete</button></td></tr>`).join('')}</tbody></table></div>` : ''}
    <div class="row-actions">
      <input type="file" id="ui-file" accept=".zip,application/zip" class="sr-only">
      <label class="btn primary" for="ui-file" id="ui-upload">${icon('plus')}Upload a pack (.zip)</label>
      <a class="btn" href="/api/ui-packs/original.zip" download>${icon('download')}Download the original to start from</a>
    </div>
    <p class="small faint">A pack replaces built-in files with the same path. <b>Its scripts run as whoever is signed in and can do anything you can</b>: only upload packs you made or trust. Uploading or choosing one asks for your password.</p>
    <p class="small faint">If a pack ever breaks the pages, open <a class="mono" href="/original">${esc(location.origin)}/original</a>: that browser then shows the original interface, and you can switch back here.</p>
  </section>`;
  const use = async (id) => {
    await api('/api/ui-packs/active', { method: 'PUT', body: { id } });
    toast('Switching the interface…');
    location.reload();
  };
  box.querySelector('#ui-pick').onchange = async (e) => {
    try { await use(e.target.value || null); } catch (err) { e.target.value = ui.active || ''; toast(err.message, 'bad'); }
  };
  box.querySelectorAll('[data-use]').forEach((b) => { b.onclick = () => busy(b, () => use(b.dataset.use)); });
  box.querySelectorAll('[data-del]').forEach((b) => {
    b.onclick = async () => {
      const x = ui.packs.find((p) => p.id === b.dataset.del);
      if (!(await confirmDialog({ title: 'Delete this interface?', body: `<p><b>${esc(x?.name || '')}</b> is deleted from the server.${x?.id === ui.active ? ' Everyone gets the original interface.' : ''}</p>`, ok: 'Delete', danger: true }))) return;
      await busy(b, async () => {
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
      const data = await upload('/api/ui-packs/upload', f, { 'Content-Type': 'application/zip', 'X-File-Name': encodeURIComponent(f.name) });
      if (await confirmDialog({ title: 'Use it now?', body: `<p><b>${esc(data.pack.name)}</b> is installed (${data.pack.files} files). Use it for everyone now? You can switch back to Original here any time.</p>`, ok: 'Use it' })) await use(data.pack.id);
      else iface(box);
    } catch (err) { toast(err.message, 'bad'); }
  };
}

// ---------- updates ----------
async function updates(box) {
  const u = await api('/api/updates');
  const cur = u.current || {};
  const running = `${cur.sha ? `${cur.sha.slice(0, 7)}${u.tag ? ` (${u.tag})` : ''}` : 'built from source'}${cur.builtAt ? ` · built ${String(cur.builtAt).slice(0, 10)}` : ''}`;
  const l = u.latest;
  box.innerHTML = `<section class="card"><header class="card-h"><h2>Updates</h2>${u.updateAvailable ? chip('update available', 'green') : ''}</header>
    <p class="small muted">${u.enabled ? 'Updates come as a new image. To install one, run <code>docker compose pull &amp;&amp; docker compose up -d</code> where you set up Sentry Six Manager. Settings, footage and the Recycle Bin stay.' : u.image ? 'Checking for updates is turned off (UPDATE_CHECK=off). To update, run <code>docker compose pull &amp;&amp; docker compose up -d</code>.' : 'This copy was built from source. To update it, build the image again from the new code.'}</p>
    <dl class="kv"><dt>running</dt><dd class="mono">${esc(running)}</dd>${u.image ? `<dt>image</dt><dd class="mono">${esc(u.image)}</dd>` : ''}
      ${u.enabled ? `<dt>newest</dt><dd class="mono">${l ? esc(`${l.revision ? `${l.revision.slice(0, 7)} · ` : ''}published ${String(l.created || '').slice(0, 10)}`) : esc(u.error || 'not checked yet')}</dd><dt>checked</dt><dd>${esc(isoish(u.checkedAt))}</dd>` : ''}</dl>
    ${u.enabled ? `<div class="row-actions"><button class="btn" type="button" id="upd-check">${icon('refresh')}Check now</button></div>` : ''}</section>`;
  box.querySelector('#upd-check')?.addEventListener('click', (e) => busy(e.currentTarget, async () => {
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
  const covered = !host || (tls.hostnames || []).map((h) => h.toLowerCase()).includes(host.toLowerCase());
  const fp = (s) => esc(s || '?').replace(/:/g, ':<wbr>');
  let body = `<dl class="kv"><dt>this connection</dt><dd>${sec.https ? 'HTTPS (encrypted)' : '<b class="bad-text">not encrypted</b>: use https:// or a reverse proxy that does HTTPS.'}</dd>
    <dt>server process</dt><dd>${sec.runningAsRoot ? 'runs as root (not supervised; fine for development, not for the Docker image)' : 'runs as an unprivileged user'}</dd>`;
  if (sec.tlsMode === 'off') body += '<dt>HTTPS</dt><dd>turned off (TLS_MODE=off): only behind a reverse proxy that does HTTPS.</dd></dl>';
  else if (tls.mode === 'own') body += `<dt>certificate</dt><dd>your own (TLS_CERT_FILE) · valid until ${esc(tls.certificate?.validTo || '?')}</dd><dt>fingerprint</dt><dd class="mono small">${fp(tls.certificate?.fingerprint)}</dd></dl>`;
  else if (tls.error) body += `<dt>certificate</dt><dd>${esc(tls.error)}</dd></dl>`;
  else {
    body += `<dt>certificate SHA-256</dt><dd class="mono small">${fp(tls.certificate?.fingerprint)}</dd><dt>valid until</dt><dd>${esc(tls.certificate?.validTo || '?')} (renews by itself)</dd>
      <dt>covers</dt><dd class="mono small">${esc((tls.hostnames || []).join(', '))}</dd><dt>certificate authority</dt><dd>valid until ${esc(tls.ca?.validTo || '?')} · <span class="mono small">${fp(tls.ca?.fingerprint)}</span></dd></dl>
      ${covered ? '' : `<div class="note amber small">You opened this page as <b>${esc(host)}</b>, which the certificate does not cover. <button class="btn sm" type="button" id="sec-add" data-host="${esc(host)}">Add ${esc(host)}</button></div>`}
      <p class="small muted">Every device shows the browser's certificate warning once. To avoid it, install the certificate authority on the device (compare its fingerprint first). It can only vouch for local names and private addresses.</p>
      <details class="more"><summary>How to install the certificate authority</summary><ul class="small">
        <li><b>iPhone / iPad:</b> open the download in Safari, install it in Settings › General › VPN &amp; Device Management, then turn on full trust in Settings › General › About › Certificate Trust Settings.</li>
        <li><b>Android:</b> Settings › Security › Encryption &amp; credentials › Install a certificate › CA certificate.</li>
        <li><b>Windows:</b> open the file › Install Certificate › Local Machine › Trusted Root Certification Authorities.</li>
        <li><b>macOS:</b> open it in Keychain Access (System) and set Trust to Always Trust.</li></ul></details>
      <form id="sec-hosts">
        <label class="field">Extra names and addresses for the certificate<input class="input mono" name="hostnames" value="${esc((tls.editable || []).join(', '))}" placeholder="192.168.1.20, nas.local" spellcheck="false"></label>
        <p class="faint small">Names from TLS_HOSTNAMES: ${esc((tls.fromEnv || []).join(', ') || 'none')}. Saving makes a new certificate and asks for your password.</p>
        <div class="row-actions"><a class="btn" href="/api/security/ca.crt" download>${icon('download')}Download certificate authority</a><button class="btn primary" type="submit">Save names</button></div>
      </form>`;
  }
  box.innerHTML = `<section class="card"><header class="card-h"><h2>Security</h2>${sec.https ? chip('HTTPS', 'green') : chip('plain HTTP', 'red')}</header>${body}</section>`;
  const save = async (names) => {
    if (!(await confirmDialog({ title: 'Make a new certificate?', body: '<p>The certificate will cover the new names. Devices that continued past the browser\'s warning see it once more.</p>', ok: 'Save names' }))) return;
    await busy(null, async () => {
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
async function system(box) {
  const [sys, ctx] = await Promise.all([api('/api/system'), api('/api/stats').catch(() => ({}))]);
  const dataVol = (ctx.filesystems || []).find((f) => !f.vehicle)?.path;
  state.system = sys;
  const caps = sys.converter?.capabilities || {};
  const gpus = [...(sys.gpu?.nvidia || []).map((g) => `${g.name} (driver ${g.driver})`), ...(sys.gpu?.gpus || []).filter((g) => g.vendor !== 'nvidia').map((g) => `${g.name || g.vendorName} · ${g.node}${g.virtual ? ' · not a GPU' : g.passedThrough ? (g.encodes ? ` · encodes ${Object.entries(g.encodes).filter(([, x]) => x).map(([k]) => k.toUpperCase()).join(', ') || 'nothing'}` : '') : ' · not passed into the container'}`)];
  box.innerHTML = `<section class="card"><header class="card-h"><h2>System</h2></header><dl class="kv">
    <dt>version</dt><dd class="mono">${esc(ctx.host?.version || sys.version?.sha || 'dev')}</dd>
    <dt>converter</dt><dd>${sys.converter?.ready ? `ready · replace originals ${esc(caps.replacement)} · cleanup ${esc(caps.ownershipCleanup)} · publication ${esc(caps.separatePublication)}` : `not ready (${esc(sys.converter?.error || 'starting')})`}</dd>
    <dt>safe rename helper</dt><dd>${sys.nativeHelper ? 'installed' : 'missing (link + unlink fallback)'}</dd>
    <dt>GPUs</dt><dd>${gpus.length ? gpus.map(esc).join('<br>') : 'none visible (the CPU encoders are used)'}</dd>
    ${(sys.gpu?.hints || []).length ? `<dt>GPU hints</dt><dd class="small">${sys.gpu.hints.map(esc).join('<br>')}</dd>` : ''}
    <dt>data volume free</dt><dd class="num">${bytes(sys.dataFree)}</dd>
    <dt>data volume</dt><dd class="mono small">${esc(dataVol || '—')}</dd><dt>converted copies</dt><dd class="mono small">${esc(dataVol ? `${dataVol}/converted` : '—')}</dd>
    <dt>server time zone</dt><dd>${esc(sys.timezone)}</dd>
    <dt>HTTPS</dt><dd>${sys.security?.https ? 'on' : 'off'} · TLS mode ${esc(sys.security?.tlsMode)} · ${sys.security?.supervised ? 'supervised' : 'not supervised'}${fin(sys.security?.uid) ? ` · uid ${sys.security.uid}` : ''}</dd>
  </dl></section>`;
}

// ---------- electricity ----------
async function power(box) {
  const s = await api('/api/settings');
  const p = s.power || { currency: '$', mode: 'flat', rates: [] };
  const tz = state.system?.timezone || '';
  let mode = p.mode === 'tou' ? 'tou' : 'flat';
  const rateRow = (r = {}) => {
    const days = new Set(Array.isArray(r.days) ? r.days : [0, 1, 2, 3, 4, 5, 6]);
    return `<div class="rate" data-rate>
      <label class="field">Name<input class="input" data-k="label" maxlength="24" value="${esc(r.label || '')}" placeholder="Off-peak"></label>
      <label class="field">Price per kWh<input class="input num" data-k="price" inputmode="decimal" value="${fin(r.price) ? r.price : ''}" placeholder="0.12"></label>
      <label class="field">From<input class="input num" type="time" data-k="from" value="${esc(r.from || '23:00')}"></label>
      <label class="field">To<input class="input num" type="time" data-k="to" value="${esc(r.to || '07:00')}"></label>
      <div class="field">Days<div class="daypick">${WEEK.map(([d, n]) => `<label><input type="checkbox" value="${d}"${days.has(d) ? ' checked' : ''}><span>${n}</span></label>`).join('')}</div></div>
      <button class="btn sm ghost" type="button" data-rate-del aria-label="Remove this rate">${icon('x')}Remove</button></div>`;
  };
  box.innerHTML = `<form class="card form-card" id="pw-price" novalidate>
    <header class="card-h"><h2>Electricity price</h2></header>
    <p class="small muted">For the costs next to energy on the Overview, the Encoder and Jobs, and for "off-peak only" automatic conversion. Leave empty for energy only.</p>
    <div class="field">Plan${seg('pmode', [['flat', 'One price'], ['tou', 'Time of use']], mode, 'Plan')}</div>
    <div class="grid2">
      <label class="field">Currency<input class="input" name="currency" maxlength="3" value="${esc(p.currency || '$')}"></label>
      <label class="field" data-plan="flat"${mode === 'flat' ? '' : ' hidden'}>Price per kWh<input class="input num" name="pricePerKwh" inputmode="decimal" value="${fin(p.pricePerKwh) ? p.pricePerKwh : ''}" placeholder="0.15"></label>
      <label class="field" data-plan="tou"${mode === 'tou' ? '' : ' hidden'}>Other hours (per kWh)<input class="input num" name="defaultPrice" inputmode="decimal" value="${fin(p.defaultPrice) ? p.defaultPrice : ''}" placeholder="0.25"></label>
    </div>
    <div data-plan="tou"${mode === 'tou' ? '' : ' hidden'}>
      <p class="faint small">Rates in order: the first whose days and hours match wins. 23:00 to 07:00 runs over midnight. Server time${tz ? ` (${esc(tz)})` : ''}.</p>
      <div class="rates" id="rates">${(p.rates || []).map(rateRow).join('')}</div>
      <button class="btn sm" type="button" id="rate-add">${icon('plus')}Add a rate</button>
    </div>
    <div class="row-actions"><button class="btn primary" type="submit">Save price</button></div></form>`;
  const form = box.querySelector('#pw-price');
  const list = box.querySelector('#rates');
  wireSeg(form, 'pmode', (m) => {
    mode = m;
    form.querySelectorAll('[data-plan]').forEach((n) => { n.hidden = n.dataset.plan !== m; });
    if (m === 'tou' && !list.children.length) list.insertAdjacentHTML('beforeend', rateRow({ label: 'Off-peak' }));
  });
  box.querySelector('#rate-add').onclick = () => {
    if (list.children.length >= 12) return;
    list.insertAdjacentHTML('beforeend', rateRow(list.children.length ? { label: 'Peak', from: '16:00', to: '21:00', days: [1, 2, 3, 4, 5] } : { label: 'Off-peak' }));
  };
  list.addEventListener('click', (e) => { e.target.closest('[data-rate-del]')?.closest('[data-rate]').remove(); });
  form.onsubmit = (e) => {
    e.preventDefault();
    const fd = new FormData(form);
    const n = (x) => (String(x ?? '').trim() === '' ? null : Number(String(x).replace(',', '.')));
    const rates = [...list.querySelectorAll('[data-rate]')].map((row) => {
      const g = (k) => row.querySelector(`[data-k="${k}"]`).value;
      return { label: g('label').trim(), price: n(g('price')), from: g('from'), to: g('to'), days: [...row.querySelectorAll('.daypick input:checked')].map((x) => Number(x.value)) };
    });
    const body = { currency: String(fd.get('currency') || '').trim() || '$', mode, pricePerKwh: n(fd.get('pricePerKwh')), defaultPrice: n(fd.get('defaultPrice')), rates: mode === 'tou' ? rates : (p.rates || []) };
    if ([body.pricePerKwh, body.defaultPrice, ...rates.map((r) => r.price)].some(Number.isNaN)) { toast('Enter prices as numbers, like 0.15.', 'bad'); return; }
    busy(form.querySelector('[type=submit]'), async () => {
      state.power = await api('/api/settings/power', { method: 'PUT', body });
      toast('Saved. Costs follow this price from now on.');
    });
  };
}

// ---------- appearance ----------
async function appearance(box) {
  const s = await api('/api/settings');
  const calm = Boolean(s.appearance?.reduceEffects);
  box.innerHTML = `<section class="card"><header class="card-h"><h2>Appearance</h2></header>
    <p class="small muted">Flux is dark only. Motion follows your system's reduced-motion setting; you can also turn it down for everyone here.</p>
    <label class="check"><input type="checkbox" id="calm"${calm ? ' checked' : ''}> Reduce effects (no animations or glow, for slower devices)</label>
    <label class="check"><input type="checkbox" id="dense"${store.get('dense', false) ? ' checked' : ''}> Extra-dense tables in this browser</label>
    <p class="small faint">Keyboard: press <kbd>?</kbd> for every shortcut, <kbd>Ctrl</kbd> <kbd>K</kbd> for the command palette.</p></section>`;
  box.querySelector('#calm').onchange = (e) => busy(null, async () => {
    await api('/api/settings/appearance', { method: 'PUT', body: { reduceEffects: e.target.checked } });
    document.documentElement.classList.toggle('calm', e.target.checked);
    toast('Saved.');
  });
  box.querySelector('#dense').onchange = (e) => {
    store.set('dense', e.target.checked);
    document.documentElement.classList.toggle('dense', e.target.checked);
  };
}
