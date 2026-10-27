// Settings: vehicles (with a guided "add my vehicle"), account, look,
// interface packs, security, updates, system and the electricity price.

import { api, upload, esc, enc, icon, bytes, plural, when, ago, chip, kv, details, emptyState, confirmDialog, modal, toast, fail, busy, store, fin } from '../core.js';
import { state, loadVehicles, shareHealth, setVehicle, vehicleById } from '../state.js';
import { go, setTheme, currentTheme, signOut } from '../app.js';

const SECTIONS = [
  ['vehicles', 'Vehicles', 'car'], ['account', 'Account', 'key'], ['look', 'Look', 'palette'], ['interface', 'Interface', 'grid'],
  ['security', 'Security', 'lock'], ['updates', 'Updates', 'download'], ['system', 'System & power', 'server']
];

export async function render(ctx) {
  const { view, params } = ctx;
  let section = params[0] || 'vehicles';
  if (section === 'add-vehicle' || section === 'vehicle') { /* vehicle pages */ } else if (!SECTIONS.some(([k]) => k === section)) section = 'vehicles';
  const navKey = section === 'add-vehicle' || section === 'vehicle' ? 'vehicles' : section;
  view.innerHTML = `<div class="page">
    <div class="page-head"><div><h1>Settings</h1></div><div class="head-actions"><button class="btn btn-ghost" type="button" id="signout">${icon('logout')} Sign out</button></div></div>
    <div class="settings-layout"><nav class="settings-nav" aria-label="Settings sections">${SECTIONS.map(([k, label, ic]) => `<a href="#/settings/${k}" class="${k === navKey ? 'active' : ''}"${k === navKey ? ' aria-current="page"' : ''}>${icon(ic)} ${label}</a>`).join('')}</nav>
      <div id="section"><div class="loading"><span class="spin"></span><span>Loading…</span></div></div></div></div>`;
  view.querySelector('#signout').onclick = signOut;
  // keep the chosen tab in view on phones
  view.querySelector('.settings-nav a.active')?.scrollIntoView({ block: 'nearest', inline: 'center' });
  const el = view.querySelector('#section');
  const sub = { el, ctx };
  if (section === 'vehicles') return vehicles(sub);
  if (section === 'add-vehicle') return addVehicle(sub);
  if (section === 'vehicle') return editVehicle(sub, params[1]);
  if (section === 'account') return account(sub);
  if (section === 'look') return look(sub);
  if (section === 'interface') return iface(sub);
  if (section === 'security') return security(sub);
  if (section === 'updates') return updates(sub);
  return system(sub);
}

// ---------- vehicles ----------
const sourceText = (v) => (v.source.type === 'smb' ? v.source.share : v.source.path);
async function vehicles({ el, ctx }) {
  const draw = () => {
    el.innerHTML = `<div class="row-between" style="margin-bottom:16px"><div><h2>Vehicles</h2><p class="muted" style="margin-top:4px">Each vehicle has its own footage: a network share (like a NAS or TeslaUSB) or a folder on this server.</p></div>
      <a class="btn btn-primary" href="#/settings/add-vehicle">${icon('plus')} Add a vehicle</a></div>
      ${state.vehicles.length ? `<div class="stack">${state.vehicles.map((v) => {
        const h = shareHealth(v);
        return `<div class="card"><div class="row-between"><div class="row"><span class="status-icon" style="width:46px;height:46px;border-radius:14px;display:grid;place-items:center;background:var(--surface-2)">${icon('car')}</span>
          <div><h3>${esc(v.name)}</h3><p class="muted small">${esc(v.timezone)}</p></div></div>${chip(h.word, h.tone)}</div>
          ${h.detail ? `<p class="small" style="margin-top:10px;color:var(--${h.tone === 'bad' ? 'bad' : 'warn'})">${esc(h.detail)}</p>` : ''}
          ${v.share?.warning ? details('Something to know', `<p class="small">${esc(v.share.warning)}</p>`) : ''}
          ${details('More details', kv([['Footage', `<span class="mono">${esc(sourceText(v))}</span>`], ['Connection', v.security ? esc(v.security) : v.source.type === 'path' ? 'A folder on this server' : ''], ['Free space', fin(v.share?.freeBytes) ? `${bytes(v.share.freeBytes)} of ${bytes(v.share.totalBytes)}` : ''], ['Inside the server', `<span class="mono">${esc(v.root)}</span>`]]))}
          <div class="actions"><a class="btn btn-sm" href="#/settings/vehicle/${enc(v.id)}">Edit</a>${v.source.type === 'smb' || !h.ok ? `<button class="btn btn-ghost btn-sm" type="button" data-reconnect="${esc(v.id)}">${icon('refresh')} Reconnect</button>` : ''}</div></div>`;
      }).join('')}</div>` : emptyState({ art: 'car', title: 'No vehicles yet', text: 'Add your Tesla to start looking after its footage.', action: '<a class="btn btn-primary" href="#/settings/add-vehicle">Add my vehicle</a>' })}`;
    el.querySelectorAll('[data-reconnect]').forEach((b) => {
      b.onclick = () => busy(b, async () => {
        try {
          const out = await api(`/api/vehicles/${enc(b.dataset.reconnect)}/reconnect`, { body: {} });
          toast(out.share?.healthy ? 'Connected.' : `Still can’t connect${out.share?.lastError ? `: ${out.share.lastError}` : '.'}`, { kind: out.share?.healthy ? 'good' : 'bad' });
          await loadVehicles();
          draw();
        } catch (err) { fail(err); }
      });
    });
  };
  draw();
  ctx.on('vehicles', () => { if (!el.contains(document.activeElement)) draw(); });
}

function timezoneField(value) {
  let zones = [];
  try { zones = Intl.supportedValuesOf('timeZone'); } catch { /* older browser */ }
  if (!zones.length) return `<label class="field"><span>Time zone</span><input class="input" name="timezone" value="${esc(value)}" placeholder="America/Chicago"></label>`;
  if (!zones.includes(value)) zones = [value, ...zones];
  return `<label class="field"><span>Time zone</span><select class="input" name="timezone">${zones.map((z) => `<option${z === value ? ' selected' : ''}>${esc(z)}</option>`).join('')}</select><span class="hint">Where the car usually is: Tesla names clips in local time.</span></label>`;
}
function smbFields(s, versions) {
  return `<label class="field full"><span>Share address</span><input class="input mono" name="share" value="${esc(s.share || '')}" placeholder="//192.168.1.50/TeslaCam" autocomplete="off" autocapitalize="none" spellcheck="false"><span class="hint">Like //nas.local/TeslaCam or //192.168.1.50/TeslaCam</span></label>
    <label class="field"><span>User name</span><input class="input" name="username" value="${esc(s.username || '')}" autocomplete="off" autocapitalize="none" spellcheck="false"></label>
    <label class="field"><span>Password</span><input class="input" name="password" type="password" placeholder="${s.passwordSet ? 'Saved. Leave empty to keep it' : ''}" autocomplete="new-password"></label>
    <div class="full smb-test"><button class="btn" type="button" data-smb-test>Check the password</button><p class="small" data-smb-test-out role="status" aria-live="polite"></p></div>
    <div class="full">${details('More details', `<div class="form-grid">
      <label class="field"><span>Domain (optional)</span><input class="input" name="domain" value="${esc(s.domain || '')}" autocomplete="off"></label>
      <label class="field"><span>SMB version</span><select class="input" name="version">${Object.entries(versions).map(([k, t]) => `<option value="${esc(k)}"${String(s.version || '3.1.1') === k ? ' selected' : ''}>${esc(t)}</option>`).join('')}</select></label>
      <label class="field"><span>Port (optional)</span><input class="input" name="port" inputmode="numeric" value="${esc(s.port || '')}" placeholder="445"></label>
      <label class="check full"><input type="checkbox" name="encrypt"${s.encrypt === false ? '' : ' checked'}> <span>Encrypt the connection (recommended). Without it the connection is still signed, so nobody can change the footage, but others on the network could watch it.</span></label>
      <p class="muted small full">Only SMB 3 is used and every connection is signed. Use a NAS account that can only reach this share.</p></div>`)}</div>`;
}
function readSource(form, type) {
  const f = new FormData(form);
  return type === 'path'
    ? { type: 'path', path: String(f.get('path') || '').trim() }
    : { type: 'smb', share: String(f.get('share') || '').trim(), username: String(f.get('username') || '').trim(), password: f.get('password') || undefined, domain: String(f.get('domain') || ''), version: f.get('version') || '3.1.1', encrypt: f.get('encrypt') === 'on', port: f.get('port') || null };
}
async function smbVersions() {
  if (!state.system) state.system = await api('/api/system').catch(() => null);
  return state.system?.smbVersions || { '3.1.1': 'SMB 3.1.1 (recommended)', '3.02': 'SMB 3.02', '3.0': 'SMB 3.0', 3: 'SMB 3.0 or newer' };
}

async function addVehicle({ el, ctx }) {
  const versions = await smbVersions();
  const d = store.get('addVehicleDraft', null) || {};
  const draft = { step: 1, type: d.type === 'path' ? 'path' : 'smb', name: '', timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC', source: { version: state.system?.smbDefaultVersion || '3.1.1', encrypt: true } };
  const STEPS = ['Where', 'Details', 'Check'];
  const draw = () => {
    let body = '';
    if (draft.step === 1) {
      body = `<h2>Where does the car’s footage live?</h2><p class="muted" style="margin:6px 0 18px">Pick the one that matches your setup.</p>
        <div class="choices"><button type="button" class="choice" data-type="smb" aria-pressed="${draft.type === 'smb'}"><span class="choice-icon">${icon('network')}</span><span><b>On a network share</b><span>A NAS, a TeslaUSB or another computer sharing a folder (SMB).</span></span></button>
          <button type="button" class="choice" data-type="path" aria-pressed="${draft.type === 'path'}"><span class="choice-icon">${icon('folder')}</span><span><b>In a folder on this server</b><span>A folder you mounted into the container yourself.</span></span></button></div>`;
    } else if (draft.step === 2) {
      body = `<h2>Tell us about it</h2><p class="muted" style="margin:6px 0 18px">${draft.type === 'smb' ? 'The share’s address and an account that can read it.' : 'The folder’s path inside the container.'}</p>
        <form class="form-grid" id="veh-form">
          <label class="field"><span>Vehicle name</span><input class="input" name="name" value="${esc(draft.name)}" placeholder="My Model Y" required></label>
          ${timezoneField(draft.timezone)}
          ${draft.type === 'smb' ? smbFields(draft.source, versions) : `<label class="field full"><span>Folder</span><input class="input mono" name="path" value="${esc(draft.source.path || '')}" placeholder="/footage/model-y" autocapitalize="none" spellcheck="false"><span class="hint">A folder you mounted into the container (bind mount or Docker volume).</span></label>`}
        </form>`;
    } else {
      const s = draft.source;
      body = `<h2>Ready to add ${esc(draft.name)}</h2><p class="muted" style="margin:6px 0 18px">We’ll ask for your password once, because this decides where footage comes from.</p>
        <ul class="summary-list"><li>${icon('car')}<span><b>${esc(draft.name)}</b>, clips in ${esc(draft.timezone)} time</span></li>
          <li>${icon(draft.type === 'smb' ? 'network' : 'folder')}<span>${draft.type === 'smb' ? `Share <span class="mono">${esc(s.share)}</span> as ${esc(s.username || 'guest')}, ${s.encrypt === false ? 'signed' : 'encrypted'}` : `Folder <span class="mono">${esc(s.path)}</span>`}</span></li>
          <li>${icon('shieldCheck')}<span>Sentry Six only reads it and moves things to the Recycle Bin when you ask. Nothing is deleted without you.</span></li></ul>`;
    }
    el.innerHTML = `<div class="wizard"><a class="back-link" href="#/settings/vehicles">${icon('back')} Vehicles</a>
      <h2 style="font-size:26px;margin-bottom:16px">Add a vehicle</h2>
      <ol class="steps">${STEPS.map((s, i) => `<li class="${i + 1 === draft.step ? 'on' : i + 1 < draft.step ? 'done' : ''}"${i + 1 === draft.step ? ' aria-current="step"' : ''}><span class="n">${i + 1 < draft.step ? icon('check') : i + 1}</span><span>${s}</span></li>`).join('')}</ol>
      <div class="card">${body}<div class="wiz-foot"><button class="btn" type="button" id="back">${draft.step === 1 ? 'Cancel' : 'Back'}</button>
        <button class="btn btn-primary" type="button" id="next">${draft.step === 3 ? `${icon('plus')} Add vehicle` : `Next ${icon('next')}`}</button></div></div></div>`;
    el.querySelectorAll('[data-type]').forEach((b) => { b.onclick = () => { draft.type = b.dataset.type; draft.step = 2; draw(); el.querySelector('input')?.focus(); }; });
    wireSmbTest(el, null);
    el.querySelector('#back').onclick = () => { if (draft.step === 1) go('#/settings/vehicles'); else { keep(); draft.step -= 1; draw(); } };
    el.querySelector('#next').onclick = (e) => next(e.currentTarget);
    el.querySelector('#veh-form')?.addEventListener('submit', (e) => { e.preventDefault(); next(el.querySelector('#next')); });
  };
  const keep = () => {
    const form = el.querySelector('#veh-form');
    if (!form) return;
    const f = new FormData(form);
    draft.name = String(f.get('name') || '').trim();
    draft.timezone = String(f.get('timezone') || draft.timezone);
    draft.source = { ...draft.source, ...readSource(form, draft.type) };
  };
  const next = async (btn) => {
    if (draft.step === 1) { draft.step = 2; draw(); return; }
    if (draft.step === 2) {
      keep();
      if (!draft.name) return toast('Give the vehicle a name.', { kind: 'bad' });
      if (draft.type === 'smb' && !/^(\/\/|\\\\)[^/\\]+[/\\][^/\\]/.test(draft.source.share)) return toast('Enter the share as //server/share.', { kind: 'bad' });
      if (draft.type === 'path' && !draft.source.path.startsWith('/')) return toast('Enter the folder as a full path, starting with /.', { kind: 'bad' });
      draft.step = 3;
      draw();
      return undefined;
    }
    store.set('addVehicleDraft', { type: draft.type });
    return busy(btn, async () => {
      try {
        const src = draft.type === 'path' ? { type: 'path', path: draft.source.path } : { type: 'smb', share: draft.source.share, username: draft.source.username, password: draft.source.password, domain: draft.source.domain, version: draft.source.version, encrypt: draft.source.encrypt !== false, port: draft.source.port || null };
        const saved = await api('/api/vehicles', { body: { name: draft.name, timezone: draft.timezone, source: src } });
        await loadVehicles();
        setVehicle(saved.id);
        el.innerHTML = `<div class="wizard">${emptyState({ art: 'checkCircle', title: `${saved.name} is added`, text: 'We’re connecting to its footage and looking through it. It shows up in Footage in a moment.', action: `<div class="row" style="justify-content:center"><a class="btn btn-primary" href="#/footage?vehicle=${enc(saved.id)}">See its footage</a><a class="btn" href="#/settings/vehicles">Back to vehicles</a></div>` })}</div>`;
      } catch (err) { fail(err); }
    });
  };
  draw();
}

async function editVehicle({ el }, id) {
  const v = vehicleById(id);
  if (!v) { el.innerHTML = emptyState({ art: 'car', title: 'That vehicle isn’t here any more', action: '<a class="btn btn-soft" href="#/settings/vehicles">Back to vehicles</a>' }); return; }
  const versions = await smbVersions();
  let type = v.source.type === 'path' ? 'path' : 'smb';
  const draw = () => {
    el.innerHTML = `<a class="back-link" href="#/settings/vehicles">${icon('back')} Vehicles</a>
      <form class="card stack" id="veh-form"><h2>Edit ${esc(v.name)}</h2>
        <div class="form-grid"><label class="field"><span>Vehicle name</span><input class="input" name="name" value="${esc(v.name)}" required></label>${timezoneField(v.timezone)}</div>
        <div><p class="field" style="margin-bottom:8px">Footage is</p><div class="seg" role="group" aria-label="Footage source"><button type="button" data-type="smb" aria-pressed="${type === 'smb'}">On a network share</button><button type="button" data-type="path" aria-pressed="${type === 'path'}">In a folder</button></div></div>
        <div class="form-grid">${type === 'smb' ? smbFields(v.source.type === 'smb' ? v.source : { version: '3.1.1', encrypt: true }, versions) : `<label class="field full"><span>Folder</span><input class="input mono" name="path" value="${esc(v.source.path || '')}" placeholder="/footage/car" autocapitalize="none" spellcheck="false"></label>`}</div>
        <p class="muted small">Changing where footage comes from asks for your password.</p>
        <div class="row"><button class="btn btn-primary" type="submit">Save</button><a class="btn" href="#/settings/vehicles">Cancel</a><span class="spacer"></span><button class="btn btn-ghost" type="button" id="remove" style="color:var(--bad)">${icon('trash')} Remove vehicle</button></div>
      </form>`;
    el.querySelectorAll('[data-type]').forEach((b) => { b.onclick = () => { type = b.dataset.type; draw(); }; });
    wireSmbTest(el, v.id);
    el.querySelector('#veh-form').onsubmit = (e) => {
      e.preventDefault();
      const form = e.target;
      const f = new FormData(form);
      const body = { name: String(f.get('name') || '').trim(), timezone: String(f.get('timezone') || '') , source: readSource(form, type) };
      const was = v.source;
      const same = type === was.type && (type === 'path' ? body.source.path === was.path
        : ['share', 'username', 'domain', 'version'].every((k) => String(body.source[k] ?? '') === String(was[k] ?? '')) && body.source.encrypt === (was.encrypt !== false) && String(body.source.port ?? '') === String(was.port ?? '') && !body.source.password);
      if (same) delete body.source;
      busy(e.submitter, async () => {
        try {
          await api(`/api/vehicles/${enc(v.id)}`, { method: 'PUT', body });
          await loadVehicles();
          toast(body.source ? 'Saved. Connecting to the footage…' : 'Saved.', { kind: 'good' });
          go('#/settings/vehicles');
        } catch (err) { fail(err); }
      });
    };
    el.querySelector('#remove').onclick = async (e) => {
      if (!(await confirmDialog({ title: `Remove ${esc(v.name)}?`, body: '<p>Sentry Six forgets this vehicle and disconnects its share. <b>No footage is deleted.</b></p>', ok: 'Remove', danger: true }))) return;
      await busy(e.currentTarget, async () => {
        try {
          await api(`/api/vehicles/${enc(v.id)}`, { method: 'DELETE' });
          await loadVehicles();
          toast(`${v.name} removed. Its footage is untouched.`);
          go('#/settings/vehicles');
        } catch (err) { fail(err); }
      });
    };
  };
  draw();
}

// ---------- account ----------
async function account({ el }) {
  const me = await api('/api/auth/me').catch(() => ({}));
  el.innerHTML = `<form class="card stack" id="pw"><h2>Account</h2><p class="muted">Signed in as <b>${esc(me.user || '')}</b>. Changing the password signs out every other device.</p>
    <div class="form-grid"><label class="field"><span>Current password</span><input class="input" type="password" name="current" autocomplete="current-password" required></label>
      <label class="field"><span>New password</span><input class="input" type="password" name="next" autocomplete="new-password" minlength="8" required><span class="hint">At least 8 characters</span></label>
      <label class="field"><span>New password again</span><input class="input" type="password" name="again" autocomplete="new-password" required></label></div>
    <div><button class="btn btn-primary" type="submit">Change password</button></div></form>`;
  el.querySelector('#pw').onsubmit = (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    if (String(f.get('next')).length < 8) return toast('Choose a new password of at least 8 characters.', { kind: 'bad' });
    if (f.get('next') !== f.get('again')) return toast('The new passwords don’t match.', { kind: 'bad' });
    return busy(e.submitter, async () => {
      try {
        await api('/api/auth/password', { body: { current: f.get('current'), next: f.get('next') } });
        toast('Password changed. Other devices need to sign in again.', { kind: 'good' });
        e.target.reset();
      } catch (err) { fail(err); }
    });
  };
}

// ---------- look ----------
async function look({ el }) {
  const settings = await api('/api/settings').catch(() => ({}));
  const draw = () => {
    const t = currentTheme();
    const calm = document.documentElement.classList.contains('calm');
    el.innerHTML = `<div class="card stack"><h2>Look</h2>
      <div><p class="field" style="margin-bottom:8px">Light or dark</p><div class="seg" role="group" aria-label="Light or dark">${[['auto', 'Follow my device'], ['light', 'Light'], ['dark', 'Dark']].map(([k, l]) => `<button type="button" data-theme-pick="${k}" aria-pressed="${t === k}">${l}</button>`).join('')}</div>
        <p class="muted small" style="margin-top:6px">Saved in this browser.</p></div>
      <label class="switch"><input type="checkbox" id="calm"${calm ? ' checked' : ''}><span>Calm mode: fewer animations, for everyone who signs in</span></label>
      <p class="muted small">Your device’s “reduce motion” setting is always respected as well.</p></div>`;
    el.querySelectorAll('[data-theme-pick]').forEach((b) => { b.onclick = () => { setTheme(b.dataset.themePick); draw(); el.querySelector(`[data-theme-pick="${b.dataset.themePick}"]`)?.focus(); }; });
    el.querySelector('#calm').onchange = async (e) => {
      const on = e.target.checked;
      document.documentElement.classList.toggle('calm', on);
      store.set('calm', on);
      try { await api('/api/settings/appearance', { method: 'PUT', body: { reduceEffects: on } }); toast(on ? 'Calm mode on.' : 'Calm mode off.', { kind: 'good' }); } catch (err) { fail(err); }
    };
  };
  if (settings.appearance) document.documentElement.classList.toggle('calm', Boolean(settings.appearance.reduceEffects));
  draw();
}

// ---------- interface ----------
async function iface({ el, ctx }) {
  let ui = await api('/api/ui-packs');
  const use = async (id) => {
    await api('/api/ui-packs/active', { method: 'PUT', body: { id } });
    location.reload();
  };
  const draw = () => {
    const active = ui.packs.find((p) => p.id === ui.active);
    el.innerHTML = `<div class="card stack"><h2>Interface</h2>
      <p class="muted">How Sentry Six Manager looks and works for everyone who signs in. <b>Original</b> is the built-in interface; the others are packs that were uploaded. You’re using <b>${esc(active ? active.name : 'Original')}</b>.</p>
      ${ui.original ? `<div class="note note-info">${icon('info')}<span>This browser shows the original interface because <span class="mono">/original</span> was opened${active ? `; everyone else sees ${esc(active.name)}` : ''}. <a class="btn btn-sm" href="/original?off=1">Show the chosen interface</a></span></div>` : ''}
      <label class="field" style="max-width:420px"><span>Interface for everyone</span><select class="input" id="ui-pick">
        <option value=""${ui.active ? '' : ' selected'}>Original</option>${ui.packs.map((p) => `<option value="${esc(p.id)}"${p.id === ui.active ? ' selected' : ''}>${esc(p.name)}</option>`).join('')}</select></label>
      ${ui.packs.length ? `<ul class="list">${ui.packs.map((p) => `<li class="list-item"><div class="grow"><b>${esc(p.name)}</b> ${p.id === ui.active ? chip('In use', 'good') : ''}
          ${p.description ? `<p class="small" style="margin-top:4px">${esc(p.description)}</p>` : ''}
          <p class="muted small" style="margin-top:4px">${p.author ? `by ${esc(p.author)} · ` : ''}${esc(p.replaces.map((k) => (k === 'web' ? 'pages' : 'Viewer and Encoder')).join(', '))} · ${plural(p.files, 'file')} · uploaded ${esc(new Date(p.uploadedAt).toLocaleDateString())}</p></div>
          <div class="item-actions"><button class="btn btn-ghost btn-sm" type="button" data-del="${esc(p.id)}">Delete</button></div></li>`).join('')}</ul>` : ''}
      <div class="row"><input type="file" id="ui-file" accept=".zip,application/zip" hidden>
        <button class="btn btn-primary" type="button" id="ui-upload">${icon('upload')} Upload a pack (.zip)</button>
        <a class="btn" href="/api/ui-packs/original.zip" download>${icon('download')} Download the original to start from</a></div>
      <div class="note note-warn">${icon('alert')}<span>A pack’s scripts run as whoever is signed in and can do anything you can. Only upload packs you made or trust. Uploading or choosing one asks for your password.</span></div>
      <div class="note">${icon('info')}<span>If a pack ever breaks the pages, open <b class="mono">${esc(location.origin)}/original</b> in the browser. That browser then shows the original interface, and you can switch back here.</span></div></div>`;
    el.querySelector('#ui-pick').onchange = async (e) => {
      try { await use(e.target.value || null); } catch (err) { e.target.value = ui.active || ''; fail(err); }
    };
    el.querySelectorAll('[data-del]').forEach((b) => {
      b.onclick = async () => {
        const p = ui.packs.find((x) => x.id === b.dataset.del);
        if (!(await confirmDialog({ title: 'Delete this interface?', body: `<p><b>${esc(p?.name || '')}</b> is deleted from the server.${p?.id === ui.active ? ' Everyone gets the original interface.' : ''}</p>`, ok: 'Delete', danger: true }))) return;
        await busy(b, async () => {
          try {
            await api(`/api/ui-packs/${enc(p.id)}`, { method: 'DELETE' });
            if (p.id === ui.active) { location.reload(); return; }
            ui = await api('/api/ui-packs');
            toast('Deleted.');
            draw();
          } catch (err) { fail(err); }
        });
      };
    });
    const file = el.querySelector('#ui-file');
    el.querySelector('#ui-upload').onclick = () => file.click();
    file.onchange = () => {
      const f = file.files[0];
      file.value = '';
      if (!f) return;
      busy(el.querySelector('#ui-upload'), async () => {
        try {
          const out = await upload('/api/ui-packs/upload', f, { 'Content-Type': 'application/zip', 'X-File-Name': encodeURIComponent(f.name) });
          ui = await api('/api/ui-packs');
          draw();
          if (await confirmDialog({ title: 'Use it now?', body: `<p><b>${esc(out.pack.name)}</b> is installed. Use it for everyone now? You can always switch back to Original here.</p>`, ok: 'Use it' })) await use(out.pack.id);
        } catch (err) { fail(err); }
      });
    };
  };
  draw();
}

// ---------- security ----------
async function security({ el }) {
  const sec = await api('/api/security');
  const tls = sec.tls || {};
  const host = String(sec.currentHost || '').replace(/:\d+$/, '').replace(/^\[|\]$/g, '');
  const covered = !host || (tls.hostnames || []).map((h) => h.toLowerCase()).includes(host.toLowerCase());
  const save = async (names, btn) => {
    if (!(await confirmDialog({ title: 'Make a new certificate?', body: '<p>The certificate will cover the new names. Devices that clicked past the browser’s warning before will see it once more; devices with the certificate authority installed won’t.</p>', ok: 'Save names' }))) return;
    await busy(btn, async () => {
      try {
        const out = await api('/api/security/hostnames', { method: 'PUT', body: { hostnames: names } });
        toast(`${out.caReplaced ? 'Saved. The certificate authority was replaced: install the new one on your devices.' : 'Saved.'} Reloading for the new certificate…`, { kind: 'good' });
        setTimeout(() => location.reload(), 2500);
      } catch (err) { fail(err); }
    });
  };
  let certBody;
  if (sec.tlsMode === 'off') certBody = '<p>HTTPS is turned off on this server (TLS_MODE=off). Only use it behind a reverse proxy that does HTTPS.</p>';
  else if (tls.mode === 'own') certBody = kv([['Certificate', `Your own · ${esc((tls.certificate?.names || []).join(', '))}`], ['Valid until', esc(tls.certificate?.validTo || '?')], ['Fingerprint', `<span class="mono small">${esc(tls.certificate?.fingerprint || '?')}</span>`]]);
  else if (tls.error) certBody = `<p>${esc(tls.error)}</p>`;
  else {
    certBody = `<p>Every phone, tablet and computer shows the browser’s certificate warning once. To be sure it’s this server, compare the fingerprint below with the one your browser shows. If a device that was fine before suddenly warns again and you changed nothing, don’t continue.</p>
      ${covered ? '' : `<div class="note note-warn" style="margin-top:12px">${icon('alert')}<span>You opened this page as <b>${esc(host)}</b>, which the certificate doesn’t cover yet. <button class="btn btn-sm" type="button" id="add-host">Add ${esc(host)}</button></span></div>`}
      <div class="row" style="margin-top:14px"><a class="btn btn-primary" href="/api/security/ca.crt" download>${icon('download')} Download the certificate authority</a></div>
      ${details('More details', kv([['Certificate fingerprint', `<span class="mono small">${esc(tls.certificate?.fingerprint || '?')}</span>`], ['Renews by itself', `before ${esc(tls.certificate?.validTo || '?')}`], ['Covers', esc((tls.hostnames || []).join(', '))], ['Authority', `valid until ${esc(tls.ca?.validTo || '?')}`], ['Authority fingerprint', `<span class="mono small">${esc(tls.ca?.fingerprint || '?')}</span>`]]))}
      ${details('How to install the certificate authority (no more warnings)', `<ul class="stack-sm small" style="padding-left:18px">
        <li><b>iPhone / iPad:</b> open the download in Safari, then Settings → General → VPN &amp; Device Management to install it, and Settings → General → About → Certificate Trust Settings to turn on full trust.</li>
        <li><b>Android:</b> Settings → Security → Encryption &amp; credentials → Install a certificate → CA certificate.</li>
        <li><b>Windows:</b> open the file → Install Certificate → Local Machine → Trusted Root Certification Authorities.</li>
        <li><b>Mac:</b> open it in Keychain Access (System), then set Trust to Always Trust.</li>
        <li><b>Firefox:</b> Settings → Privacy &amp; Security → Certificates → View Certificates → Authorities → Import.</li></ul>`)}
      <form class="stack" id="hosts" style="margin-top:14px"><label class="field"><span>Extra names and addresses for the certificate</span><input class="input mono" name="hostnames" value="${esc((tls.editable || []).join(', '))}" placeholder="192.168.1.20, nas.local" autocapitalize="none" spellcheck="false"><span class="hint">What you type in the browser to reach this server. From TLS_HOSTNAMES: ${esc((tls.fromEnv || []).join(', ') || 'none')}.</span></label>
        <div><button class="btn" type="submit">Save names</button></div></form>`;
  }
  el.innerHTML = `<div class="card stack"><h2>Security</h2>
    <div class="note ${sec.https ? 'note-good' : 'note-bad'}">${icon(sec.https ? 'lock' : 'alert')}<span>${sec.https ? '<b>This connection is encrypted (HTTPS).</b> Your password and footage can’t be read on the way.' : '<b>This connection isn’t encrypted.</b> Others on the network could read your password and footage. Use https:// or a reverse proxy that does HTTPS.'}</span></div>
    ${details('About the server process', `<p class="small">${sec.runningAsRoot ? 'It runs as root (not supervised). Fine while developing; the Docker image runs it as an ordinary user.' : 'It runs as an ordinary user; only the supervisor can connect shares.'}</p>`)}
    <h3>Certificate</h3>${certBody}</div>`;
  el.querySelector('#hosts')?.addEventListener('submit', (e) => { e.preventDefault(); save(String(new FormData(e.target).get('hostnames') || '').split(/[\s,]+/).filter(Boolean), e.submitter); });
  el.querySelector('#add-host')?.addEventListener('click', (e) => save([...(tls.editable || []), host], e.currentTarget));
}

// ---------- updates ----------
async function updates({ el }) {
  const draw = (u) => {
    const cur = u.current || {};
    const running = `${cur.sha ? `${esc(cur.sha.slice(0, 7))}${u.tag ? ` (${esc(u.tag)})` : ''}` : 'built from source'}${cur.builtAt ? ` · built ${esc(String(cur.builtAt).slice(0, 10))}` : ''}`;
    const how = '<code>docker compose pull &amp;&amp; docker compose up -d</code>';
    el.innerHTML = `<div class="card stack"><h2>Updates</h2>
      ${u.updateAvailable ? `<div class="note note-good">${icon('sparkle')}<span><b>An update is ready.</b> Run ${how} where you set up Sentry Six Manager. Settings, footage and the Recycle Bin stay as they are.</span></div>`
        : u.enabled ? `<div class="note note-good">${icon('checkCircle')}<span>You’re up to date${u.checkedAt ? ` (checked ${esc(ago(u.checkedAt))})` : ''}.</span></div>`
          : `<div class="note">${icon('info')}<span>${u.image ? `Checking for updates is turned off (UPDATE_CHECK=off). To update, run ${how}.` : 'This copy was built from source. To update it, build the image again from the new code.'}</span></div>`}
      ${kv([['Running', `<span class="mono">${running}</span>`], u.enabled ? ['Newest', u.latest ? `<span class="mono">${esc(u.latest.revision ? u.latest.revision.slice(0, 7) : '')}</span> · published ${esc(String(u.latest.created || '').slice(0, 10))}` : esc(u.error || 'not checked yet')] : null])}
      ${u.enabled ? '<div><button class="btn" type="button" id="check">Check now</button></div>' : ''}</div>`;
    el.querySelector('#check')?.addEventListener('click', (e) => busy(e.currentTarget, async () => {
      try {
        const out = await api('/api/updates/check', { body: {} });
        toast(out.error || (out.updateAvailable ? 'An update is available.' : 'You’re on the latest version.'), { kind: out.error ? 'bad' : 'good' });
        draw(await api('/api/updates'));
      } catch (err) { fail(err); }
    }));
  };
  draw(await api('/api/updates'));
}

// ---------- system and the electricity price ----------
const WEEK = [[1, 'Mon'], [2, 'Tue'], [3, 'Wed'], [4, 'Thu'], [5, 'Fri'], [6, 'Sat'], [0, 'Sun']];
const priceText = (n) => (fin(n) ? String(n) : '');
function rateRow(r = {}) {
  const days = new Set(Array.isArray(r.days) ? r.days : [0, 1, 2, 3, 4, 5, 6]);
  return `<div class="rate" data-rate>
    <label class="field"><span>Name</span><input class="input" data-k="label" maxlength="24" value="${esc(r.label || '')}" placeholder="Off-peak"></label>
    <label class="field"><span>Price per kWh</span><input class="input" data-k="price" inputmode="decimal" value="${esc(priceText(r.price))}" placeholder="0.12"></label>
    <label class="field"><span>From</span><input class="input" type="time" data-k="from" value="${esc(r.from || '23:00')}"></label>
    <label class="field"><span>Until</span><input class="input" type="time" data-k="to" value="${esc(r.to || '07:00')}"></label>
    <div class="field" style="grid-column:1/-1"><span>Days</span><div class="days-pick">${WEEK.map(([d, n]) => `<label><input type="checkbox" value="${d}"${days.has(d) ? ' checked' : ''}><span>${n}</span></label>`).join('')}</div></div>
    <div><button type="button" class="btn btn-ghost btn-sm" data-rate-del>Remove this rate</button></div></div>`;
}
async function system({ el }) {
  const [sys, settings] = await Promise.all([api('/api/system').catch(() => null), api('/api/settings')]);
  state.system = sys || state.system;
  const p = settings.power || { currency: '$', mode: 'flat', rates: [] };
  let mode = p.mode === 'tou' ? 'tou' : 'flat';
  const gpuText = (g) => {
    if (!g) return '';
    const list = [...(g.nvidia || []).map((x) => `${esc(x.name)} (driver ${esc(x.driver)})`), ...(g.gpus || []).filter((x) => x.vendor !== 'nvidia').map((x) => (x.virtual ? `${esc(x.name)} (not a real GPU, not used)` : `${esc(x.name || x.vendorName)}${x.passedThrough ? (x.encodes ? ` · converts ${esc(Object.entries(x.encodes).filter(([, y]) => y).map(([k]) => k.toUpperCase()).join(', ') || 'nothing')}` : '') : ' · not passed into the container'}`))];
    return list.length ? list.join('<br>') : 'None. Conversions use the processor.';
  };
  el.innerHTML = `<div class="stack">
    <div class="card stack"><h2>System</h2>
      ${sys ? kv([
        ['Converter', sys.converter.ready ? 'Ready' : `Not ready yet (${esc(sys.converter.error || 'starting')})`],
        ['Graphics cards', gpuText(sys.gpu)],
        ['Data folder free', bytes(sys.dataFree)],
        ['Server time zone', esc(sys.timezone)]
      ]) : '<p class="muted">System information isn’t available.</p>'}
      ${sys ? details('More details', kv([
        ['Replacing originals', esc(sys.converter.capabilities?.replacement || '—')],
        ['Cleanup', esc(sys.converter.capabilities?.ownershipCleanup || '—')],
        ['Safe rename helper', sys.nativeHelper ? 'installed' : 'missing (a slower fallback is used)'],
        ['GPU hints', (sys.gpu?.hints || []).map(esc).join('<br>')],
        ['Version', esc(sys.version?.sha ? sys.version.sha.slice(0, 7) : 'development')]
      ])) : ''}</div>
    <form class="card stack" id="power" novalidate><h2>Electricity price</h2>
      <p class="muted">Shows what converting costs, next to the energy used. Leave it empty to show energy only.</p>
      <div class="seg" role="group" aria-label="Plan"><button type="button" data-mode="flat" aria-pressed="${mode === 'flat'}">One price</button><button type="button" data-mode="tou" aria-pressed="${mode === 'tou'}">Changes by time of day</button></div>
      <div class="form-grid"><label class="field"><span>Currency</span><input class="input" name="currency" maxlength="3" value="${esc(p.currency || '$')}"></label>
        <label class="field" data-plan="flat"${mode === 'tou' ? ' hidden' : ''}><span>Price per kWh</span><input class="input" name="pricePerKwh" inputmode="decimal" value="${esc(priceText(p.pricePerKwh))}" placeholder="0.15"></label>
        <label class="field" data-plan="tou"${mode === 'tou' ? '' : ' hidden'}><span>Price at other times (per kWh)</span><input class="input" name="defaultPrice" inputmode="decimal" value="${esc(priceText(p.defaultPrice))}" placeholder="0.25"></label></div>
      <div data-plan="tou" class="stack"${mode === 'tou' ? '' : ' hidden'}>
        <p class="muted small">The first rate whose days and hours match is used. A rate from 23:00 to 07:00 runs past midnight. Times are the server’s${sys?.timezone ? ` (${esc(sys.timezone)})` : ''}.</p>
        <div class="stack" id="rates">${(p.rates || []).map(rateRow).join('')}</div>
        <div><button type="button" class="btn btn-sm" id="add-rate">${icon('plus')} Add a rate</button></div></div>
      <div><button class="btn btn-primary" type="submit">Save price</button></div></form></div>`;
  const form = el.querySelector('#power');
  const list = el.querySelector('#rates');
  form.querySelectorAll('[data-mode]').forEach((b) => {
    b.onclick = () => {
      mode = b.dataset.mode;
      form.querySelectorAll('[data-mode]').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
      form.querySelectorAll('[data-plan]').forEach((x) => { x.hidden = x.dataset.plan !== mode; });
      if (mode === 'tou' && !list.children.length) list.insertAdjacentHTML('beforeend', rateRow({ label: 'Off-peak' }));
    };
  });
  el.querySelector('#add-rate').onclick = () => {
    if (list.children.length >= 12) return toast('Up to 12 rates.');
    list.insertAdjacentHTML('beforeend', rateRow(list.children.length ? { label: 'Peak', from: '16:00', to: '21:00', days: [1, 2, 3, 4, 5] } : { label: 'Off-peak' }));
    list.lastElementChild.querySelector('input')?.focus();
    return undefined;
  };
  list.onclick = (e) => { const d = e.target.closest('[data-rate-del]'); if (d) d.closest('[data-rate]').remove(); };
  form.onsubmit = (e) => {
    e.preventDefault();
    const f = new FormData(form);
    const num = (x) => (String(x ?? '').trim() === '' ? null : Number(String(x).replace(',', '.')));
    const rates = [...list.querySelectorAll('[data-rate]')].map((row) => {
      const g = (k) => row.querySelector(`[data-k="${k}"]`).value;
      return { label: g('label').trim(), price: num(g('price')), from: g('from'), to: g('to'), days: [...row.querySelectorAll('.days-pick input:checked')].map((x) => Number(x.value)) };
    });
    const prices = mode === 'tou' ? [num(f.get('defaultPrice')), ...rates.map((r) => r.price)] : [num(f.get('pricePerKwh'))];
    if (prices.some(Number.isNaN)) return toast('Enter prices as numbers, like 0.15.', { kind: 'bad' });
    return busy(e.submitter, async () => {
      try {
        const next = await api('/api/settings/power', { method: 'PUT', body: { currency: String(f.get('currency') || '').trim() || '$', mode, pricePerKwh: num(f.get('pricePerKwh')), defaultPrice: num(f.get('defaultPrice')), rates: mode === 'tou' ? rates : (p.rates || []) } });
        state.power = next;
        toast('Price saved.', { kind: 'good' });
      } catch (err) { fail(err); }
    });
  };
}

// Test connection: the SMB details as typed, checked by the server with a
// one-off mount; nothing is saved
function wireSmbTest(root, vehicleId) {
  const btn = root.querySelector('[data-smb-test]');
  if (!btn) return;
  const out = root.querySelector('[data-smb-test-out]');
  btn.onclick = async () => {
    const f = new FormData(btn.closest('form'));
    btn.disabled = true;
    out.textContent = 'Connecting to the NAS…';
    try {
      const r = await api('/api/vehicles/test-smb', { body: {
        vehicleId: vehicleId || null,
        source: { type: 'smb', share: String(f.get('share') || '').trim(), username: String(f.get('username') || ''), password: f.get('password') || undefined, domain: String(f.get('domain') || ''), version: f.get('version') || '3.1.1', encrypt: f.get('encrypt') === 'on', port: String(f.get('port') || '').trim() || null }
      } });
      if (!out.isConnected) return;
      out.dataset.result = r.ok ? 'ok' : 'bad';
      out.textContent = r.ok
        ? `Connected: the user name and password work. ${r.footage ? `Tesla footage found${r.footage === '.' ? '' : ` in ${r.footage}`}.` : 'No TeslaCam folder found yet (an empty share, or the footage is deeper than 3 folders).'}${r.writable ? '' : ` ${r.writeProblem || 'Read-only for this account: the Recycle Bin, Protect and replacing originals need write access.'}`}`
        : `${r.stage === 'details' ? '' : 'Could not connect: '}${r.error}${r.hint ? ` ${r.hint}` : ''}`;
    } catch (err) {
      if (out.isConnected) {
        out.dataset.result = 'bad';
        out.textContent = err.message;
      }
    } finally {
      btn.disabled = false;
    }
  };
}
