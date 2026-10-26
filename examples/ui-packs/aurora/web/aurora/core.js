// Aurora core: the API client (password re-check, sign-out), formatting,
// dialogs, toasts and the state every window shares.

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const icon = (name, cls = '') => `<svg class="ico${cls ? ` ${cls}` : ''}" aria-hidden="true"><use href="#i-${name}"/></svg>`;
export const fin = (n) => typeof n === 'number' && Number.isFinite(n);
export const motionOK = () => !matchMedia('(prefers-reduced-motion: reduce)').matches;

export const store = {
  get(k, d) {
    try {
      const v = localStorage.getItem(`aurora:${k}`);
      return v === null ? d : JSON.parse(v);
    } catch {
      return d;
    }
  },
  set(k, v) {
    try { localStorage.setItem(`aurora:${k}`, JSON.stringify(v)); } catch { /* private mode */ }
  }
};

// ---------- formatting ----------
const UNITS = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
export function bytes(n, digits = 1) {
  if (n === null || n === undefined || !Number.isFinite(Number(n))) return '—';
  let v = Number(n);
  let i = 0;
  while (Math.abs(v) >= 1024 && i < UNITS.length - 1) { v /= 1024; i++; }
  return `${i === 0 ? Math.round(v) : v.toFixed(v >= 100 ? 0 : digits)} ${UNITS[i]}`;
}
export const rate = (bps) => (fin(bps) ? `${bytes(bps)}/s` : '—');
export const pct = (n, d = 0) => (fin(n) ? `${n.toFixed(d)}%` : '—');
export const num = (n, d = 0) => (fin(n) ? n.toLocaleString(undefined, { maximumFractionDigits: d, minimumFractionDigits: d }) : '—');
export const plural = (n, w, ws = `${w}s`) => `${Number(n || 0).toLocaleString()} ${Number(n) === 1 ? w : ws}`;
export function dur(ms) {
  if (!fin(ms) || ms < 0) return '—';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} s`;
  if (s < 3600) return `${Math.floor(s / 60)} min ${String(s % 60).padStart(2, '0')} s`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ${String(Math.floor((s % 3600) / 60)).padStart(2, '0')} min`;
  return `${Math.floor(s / 86400)} d ${Math.floor((s % 86400) / 3600)} h`;
}
export function clock(sec) {
  if (!fin(sec) || sec < 0) return '0:00';
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec - m * 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}
export function ago(ts) {
  if (!ts) return 'never';
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 10) return 'just now';
  if (s < 60) return `${s} s ago`;
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} d ago`;
}
export const when = (ts) => (ts ? new Date(ts).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—');
export const whenFull = (ts) => (ts ? new Date(ts).toLocaleString(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '—');
export const watts = (w) => (fin(w) ? `${w >= 10 ? Math.round(w) : w.toFixed(1)} W` : '—');
export const energy = (wh) => (fin(wh) ? (wh < 1000 ? `${wh.toFixed(wh < 100 ? 1 : 0)} Wh` : `${(wh / 1000).toFixed(2)} kWh`) : '—');
export function money(v, cur = '$') {
  if (!fin(v)) return '—';
  const n = v >= 100 ? Math.round(v).toLocaleString() : v.toFixed(2);
  return /^[a-z]+$/i.test(cur) ? `${n} ${cur}` : `${cur}${n}`;
}
export const humanize = (s) => String(s || '').replace(/[_-]+/g, ' ').replace(/^\w/, (c) => c.toUpperCase());
const asDay = (day) => new Date(`${day}T12:00:00`);
export const dayTitle = (day) => {
  const d = asDay(day);
  return Number.isNaN(d.getTime()) ? day : d.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
};
export const dayParts = (day) => {
  const d = asDay(day);
  if (Number.isNaN(d.getTime())) return { wd: '', dd: day, mon: '' };
  return { wd: d.toLocaleDateString(undefined, { weekday: 'short' }), dd: String(d.getDate()), mon: d.toLocaleDateString(undefined, { month: 'short' }) };
};
export const timeOf = (stamp) => String(stamp || '').slice(11, 16);

// ---------- toasts ----------
export function toast(msg, kind = 'ok') {
  const box = $('#toasts');
  if (!box) return;
  const el = document.createElement('div');
  el.className = `toast glass ${kind === true || kind === 'bad' ? 'bad' : kind}`;
  el.setAttribute('role', kind === 'bad' || kind === true ? 'alert' : 'status');
  el.innerHTML = `${icon(kind === 'bad' || kind === true ? 'warn' : 'check')}<span></span>`;
  el.querySelector('span').textContent = msg;
  box.append(el);
  while (box.children.length > 4) box.firstElementChild.remove();
  setTimeout(() => {
    el.classList.add('out');
    setTimeout(() => el.remove(), 350);
  }, kind === 'bad' || kind === true ? 8000 : 4500);
}

// ---------- dialogs ----------
let dlgBusy = Promise.resolve();
/** Opens the shared glass dialog with `html`; resolves { value, form } when closed. */
export function openDialog(html, { onOpen, wide = false } = {}) {
  const run = () => new Promise((resolve) => {
    const dlg = $('#dlg');
    const form = $('#dlg-form');
    dlg.classList.toggle('wide', wide);
    form.innerHTML = html;
    dlg.returnValue = '';
    const done = () => {
      dlg.removeEventListener('close', done);
      resolve({ value: dlg.returnValue, form });
    };
    dlg.addEventListener('close', done);
    dlg.showModal();
    form.querySelector('[autofocus]')?.focus();
    onOpen?.(form, dlg);
  });
  const p = dlgBusy.then(run, run);
  dlgBusy = p.catch(() => {});
  return p;
}

export async function confirmDialog({ title, body = '', ok = 'Confirm', danger = false, cancel = 'Cancel' }) {
  const { value } = await openDialog(`<h2>${esc(title)}</h2><div class="dlg-body">${body}</div>
    <div class="dlg-actions"><button class="btn" value="cancel" type="submit">${esc(cancel)}</button><button class="btn ${danger ? 'danger' : 'primary'}" value="ok" type="submit">${esc(ok)}</button></div>`);
  return value === 'ok';
}

export async function promptDialog({ title, label, value = '', ok = 'Save', type = 'text', body = '', maxlength = 200, autocomplete = 'off' }) {
  let input;
  const res = await openDialog(`<h2>${esc(title)}</h2>${body ? `<div class="dlg-body">${body}</div>` : ''}
    <label class="field dlg-field">${esc(label)}<input class="input" name="v" type="${esc(type)}" maxlength="${maxlength}" value="${esc(value)}" autocomplete="${esc(autocomplete)}" autocapitalize="off" spellcheck="false"></label>
    <div class="dlg-actions"><button class="btn" value="cancel" type="submit" formnovalidate>Cancel</button><button class="btn primary" value="ok" type="submit">${esc(ok)}</button></div>`, {
    onOpen: (form, dlg) => {
      input = form.querySelector('input[name=v]');
      input.focus();
      input.select();
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); dlg.close('ok'); }
      });
    }
  });
  return res.value === 'ok' ? input.value : null;
}

export function infoDialog(title, html, { wide = true } = {}) {
  return openDialog(`<h2>${esc(title)}</h2><div class="dlg-body">${html}</div><div class="dlg-actions"><button class="btn primary" value="ok" type="submit">Close</button></div>`, { wide });
}

let confirming = null;
/** Asks for the password and confirms it with the server; throws when cancelled. */
export function confirmPassword() {
  if (confirming) return confirming;
  confirming = (async () => {
    for (let i = 0; i < 3; i++) {
      const pw = await promptDialog({
        title: 'Confirm with your password', label: 'Password', type: 'password', ok: 'Confirm', autocomplete: 'current-password',
        body: `<p class="muted">${i ? 'That password was not right. Try again.' : 'This change affects where footage comes from or what code runs, so the server asks for your password again.'}</p>`
      });
      if (!pw) throw new ApiError('Not changed: the password was not confirmed.', 0);
      try {
        await api('/api/auth/confirm', { body: { password: pw } }, true);
        return;
      } catch (err) {
        if (err.status === 429) throw err;
      }
    }
    throw new ApiError('Not changed: the password was not confirmed.', 0);
  })();
  return confirming.finally(() => { confirming = null; });
}

// ---------- API ----------
export const CLIENT_ID = (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}${Math.random()}`.replace('.', '')).slice(0, 64);

export class ApiError extends Error {
  constructor(message, status, data) {
    super(message);
    this.status = status;
    this.data = data;
  }
}

let leaving = false;
export function signedOut() {
  if (leaving) return;
  leaving = true;
  location.href = `/login?next=${encodeURIComponent(location.pathname + location.hash)}`;
}

/** A JSON call. opts: { method, body, timeoutMs } */
export async function api(path, opts = {}, retried = false) {
  const init = { credentials: 'same-origin', headers: { 'X-Requested-With': 'sentry-six-manager' } };
  init.method = opts.method || (opts.body !== undefined ? 'POST' : 'GET');
  if (opts.body !== undefined) {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(opts.body);
  }
  const ctrl = opts.timeoutMs ? new AbortController() : null;
  const timer = ctrl ? setTimeout(() => ctrl.abort(), opts.timeoutMs) : 0;
  if (ctrl) init.signal = ctrl.signal;
  let res;
  try {
    res = await fetch(path, init);
  } catch {
    clearTimeout(timer);
    throw new ApiError(ctrl?.signal.aborted ? 'The server took too long to answer.' : 'Can’t reach the server. Reload the page; if the browser warns about the certificate, install the certificate authority (Settings → Security).', 0);
  }
  const data = await res.json().catch(() => ({}));
  clearTimeout(timer);
  if (res.status === 401 && !path.startsWith('/api/auth/')) {
    signedOut();
    throw new ApiError('Signed out.', 401);
  }
  if (res.status === 403 && data.code === 'CONFIRM_PASSWORD' && !retried) {
    await confirmPassword();
    return api(path, opts, true);
  }
  if (!res.ok) throw new ApiError(data.error || `${res.status} ${res.statusText}`, res.status, data);
  return data;
}

/** A raw-body upload (support files, interface packs), with the password re-check. */
export async function upload(path, body, headers = {}) {
  const send = () => fetch(path, { method: 'POST', credentials: 'same-origin', body, headers: { 'X-Requested-With': 'sentry-six-manager', ...headers } });
  let res;
  try {
    res = await send();
  } catch {
    throw new ApiError('Can’t reach the server.', 0);
  }
  let data = await res.json().catch(() => ({}));
  if (res.status === 403 && data.code === 'CONFIRM_PASSWORD') {
    await confirmPassword();
    res = await send();
    data = await res.json().catch(() => ({}));
  }
  if (res.status === 401) signedOut();
  if (!res.ok) throw new ApiError(data.error || `Upload failed (${res.status}).`, res.status, data);
  return data;
}

/** The converter: always resolves to its envelope { ok, value | error }. */
export async function invoke(name, payload) {
  try {
    const res = await fetch(`/api/converter/invoke/${name}`, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'sentry-six-manager', 'X-Client-Id': CLIENT_ID },
      body: payload === undefined ? '' : JSON.stringify(payload)
    });
    if (res.status === 401) {
      signedOut();
      return { ok: false, error: { code: 'SIGNED_OUT' } };
    }
    const data = await res.json().catch(() => null);
    if (!res.ok || !data) return { ok: false, error: { code: data?.error ? String(data.error) : `HTTP_${res.status}` } };
    return data;
  } catch {
    return { ok: false, error: { code: 'NETWORK_ERROR' } };
  }
}

// ---------- shared state ----------
export const bus = new EventTarget();
export const emit = (type, detail) => bus.dispatchEvent(new CustomEvent(type, { detail }));
export function on(type, fn) {
  const h = (e) => fn(e.detail);
  bus.addEventListener(type, h);
  return () => bus.removeEventListener(type, h);
}

export const state = {
  vehicles: [],
  vehicleId: store.get('vehicle', null),
  notes: [],
  power: null,
  system: null,
  route: 'sky'
};
export const current = () => state.vehicles.find((v) => v.id === state.vehicleId) || state.vehicles[0] || null;
export const footageRoot = (v) => (v ? v.studioRoot || v.root : null);

export async function loadVehicles() {
  const { vehicles } = await api('/api/vehicles');
  state.vehicles = vehicles;
  if (!vehicles.some((v) => v.id === state.vehicleId)) state.vehicleId = vehicles[0]?.id || null;
  emit('vehicles', vehicles);
  return vehicles;
}
export function setVehicle(id) {
  if (!state.vehicles.some((v) => v.id === id) || id === state.vehicleId) return;
  state.vehicleId = id;
  store.set('vehicle', id);
  emit('vehicle', id);
}
export async function loadNotes() {
  const { notifications } = await api('/api/notifications?open=1');
  state.notes = notifications;
  emit('notes', notifications);
  return notifications;
}

/** A <select> of the vehicles for a window's title bar ('' with fewer than two). */
export function vehiclePicker(id = 'veh-pick') {
  if (state.vehicles.length < 2) return '';
  const cur = current();
  return `<label class="veh-pick"><span class="sr-only">Vehicle</span>${icon('car')}<select class="input" id="${id}" data-vehicle-pick>${state.vehicles.map((v) => `<option value="${esc(v.id)}"${v.id === cur?.id ? ' selected' : ''}>${esc(v.name)}</option>`).join('')}</select></label>`;
}

/** Ring gauge SVG: value 0..1. */
export function ring(value, { size = 120, stroke = 10, cls = '', label = '' } = {}) {
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const v = Math.max(0, Math.min(1, fin(value) ? value : 0));
  return `<svg class="ring ${cls}" viewBox="0 0 ${size} ${size}" width="${size}" height="${size}" role="img" aria-label="${esc(label)}">
    <circle class="ring-track" cx="${size / 2}" cy="${size / 2}" r="${r}" stroke-width="${stroke}"/>
    <circle class="ring-fill" cx="${size / 2}" cy="${size / 2}" r="${r}" stroke-width="${stroke}" stroke-dasharray="${c.toFixed(2)}" stroke-dashoffset="${(c * (1 - v)).toFixed(2)}" transform="rotate(-90 ${size / 2} ${size / 2})"/>
  </svg>`;
}

/** A small meter bar 0..100. */
export const meter = (v, cls = '') => `<span class="meter ${cls}" aria-hidden="true"><i style="width:${Math.max(0, Math.min(100, fin(v) ? v : 0)).toFixed(1)}%"></i></span>`;

export const empty = (title, text = '', extra = '') => `<div class="empty"><div class="empty-orb">${icon('sparkle')}</div><h3>${esc(title)}</h3>${text ? `<p class="muted">${text}</p>` : ''}${extra}</div>`;
