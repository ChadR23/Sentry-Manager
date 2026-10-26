// Flux core: API client, formatting, dialogs, toasts, shared state.

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const icon = (name, cls = 'ico') => `<svg class="${cls}" aria-hidden="true"><use href="#i-${name}"/></svg>`;
export const fin = (n) => typeof n === 'number' && Number.isFinite(n);
export const reducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches || document.documentElement.classList.contains('calm');

export const store = {
  get(k, d) {
    try { const v = localStorage.getItem(`flux:${k}`); return v === null ? d : JSON.parse(v); } catch { return d; }
  },
  set(k, v) {
    try { localStorage.setItem(`flux:${k}`, JSON.stringify(v)); } catch { /* private mode */ }
  }
};

// ---------- formatting ----------
const UNITS = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
export function bytes(n, digits = 1) {
  if (!fin(Number(n)) || n === null) return '—';
  let v = Number(n);
  let i = 0;
  while (Math.abs(v) >= 1024 && i < UNITS.length - 1) { v /= 1024; i++; }
  return `${i === 0 ? Math.round(v) : v.toFixed(v >= 100 ? 0 : digits)} ${UNITS[i]}`;
}
export function rate(bps) {
  if (!fin(bps)) return '—';
  return `${bytes(bps)}/s`;
}
export const pct = (n, d = 0) => (fin(n) ? `${n.toFixed(d)}%` : '—');
export const num = (n, d = 0) => (fin(n) ? n.toLocaleString(undefined, { maximumFractionDigits: d, minimumFractionDigits: d }) : '—');
export const plural = (n, w, ws = `${w}s`) => `${Number(n || 0).toLocaleString()} ${n === 1 ? w : ws}`;
export function dur(ms) {
  if (!fin(ms) || ms < 0) return '—';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}m`;
  return `${Math.floor(s / 86400)}d ${Math.floor((s % 86400) / 3600)}h`;
}
export function clock(sec) {
  if (!fin(sec) || sec < 0) return '0:00';
  const m = Math.floor(sec / 60);
  const s = sec - m * 60;
  return `${m}:${s.toFixed(1).padStart(4, '0')}`;
}
export function ago(ts) {
  if (!ts) return 'never';
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 5) return 'just now';
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}
export const when = (ts) => (ts ? new Date(ts).toLocaleString(undefined, { year: 'numeric', month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '—');
export const isoish = (ts) => {
  if (!ts) return '—';
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
};
export const watts = (w) => (fin(w) ? `${w >= 10 ? Math.round(w) : w.toFixed(1)} W` : '—');
export function energy(wh) {
  if (!fin(wh)) return '—';
  return wh < 1000 ? `${wh.toFixed(wh < 100 ? 1 : 0)} Wh` : `${(wh / 1000).toFixed(2)} kWh`;
}
export function money(v, cur = '$') {
  if (!fin(v)) return '—';
  const n = v >= 100 ? Math.round(v).toLocaleString() : v.toFixed(2);
  return /^[a-z]+$/i.test(cur) ? `${n} ${cur}` : `${cur}${n}`;
}
export const humanize = (s) => String(s || '').replace(/[_-]+/g, ' ').replace(/^\w/, (c) => c.toUpperCase());
export const dayTitle = (day) => {
  const d = new Date(`${day}T12:00:00`);
  return Number.isNaN(d.getTime()) ? day : d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
};

// ---------- toasts ----------
export function toast(msg, kind = 'ok') {
  const box = $('#toasts');
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.innerHTML = `${icon(kind === 'bad' ? 'alert' : 'check')}<span></span>`;
  el.querySelector('span').textContent = msg;
  box.append(el);
  setTimeout(() => {
    el.classList.add('out');
    setTimeout(() => el.remove(), 300);
  }, kind === 'bad' ? 8000 : 4200);
}

// ---------- dialogs ----------
function openDialog(html, { onOpen, wide = false } = {}) {
  return new Promise((resolve) => {
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
    onOpen?.(form, dlg);
  });
}

export async function confirmDialog({ title, body = '', ok = 'Confirm', danger = false, cancel = 'Cancel' }) {
  const { value } = await openDialog(`<h2>${esc(title)}</h2><div class="dlg-body">${body}</div>
    <div class="dlg-actions"><button class="btn" value="cancel">${esc(cancel)}</button><button class="btn ${danger ? 'danger' : 'primary'}" value="ok" autofocus>${esc(ok)}</button></div>`);
  return value === 'ok';
}

export async function promptDialog({ title, label, value = '', ok = 'Save', type = 'text', body = '', maxlength = 200 }) {
  let input;
  const { value: v } = await openDialog(`<h2>${esc(title)}</h2>${body ? `<div class="dlg-body">${body}</div>` : ''}
    <label class="field" style="margin-top:12px">${esc(label)}<input class="input" name="v" type="${esc(type)}" maxlength="${maxlength}" value="${esc(value)}" autocomplete="${type === 'password' ? 'current-password' : 'off'}"></label>
    <div class="dlg-actions"><button class="btn" value="cancel" formnovalidate>Cancel</button><button class="btn primary" value="ok">${esc(ok)}</button></div>`, {
    onOpen: (form, dlg) => {
      input = form.querySelector('input[name=v]');
      input.focus();
      input.select();
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); dlg.close('ok'); }
      });
    }
  });
  return v === 'ok' ? input.value : null;
}

export function infoDialog(title, html, wide = true) {
  return openDialog(`<h2>${esc(title)}</h2><div class="dlg-body">${html}</div><div class="dlg-actions"><button class="btn primary" value="ok">Close</button></div>`, { wide });
}

let confirming = null;
async function confirmPassword() {
  if (confirming) return confirming;
  confirming = (async () => {
    for (let i = 0; i < 3; i++) {
      const pw = await promptDialog({
        title: 'Confirm with your password', label: 'Password', type: 'password', ok: 'Confirm',
        body: `<p class="muted">${i ? 'That password was not right. Try again.' : 'This change affects where footage comes from or what code runs, so the server asks for your password again.'}</p>`
      });
      if (pw === null || pw === '') throw new Error('Not changed: the password was not confirmed.');
      try {
        await api('/api/auth/confirm', { body: { password: pw } }, true);
        return;
      } catch (err) {
        if (/Too many/i.test(err.message)) throw err;
      }
    }
    throw new Error('Not changed: the password was not confirmed.');
  })();
  try { return await confirming; } finally { confirming = null; }
}

// ---------- API ----------
export const CLIENT_ID = (crypto.randomUUID ? crypto.randomUUID() : String(Math.random()).slice(2)).slice(0, 64);

export class ApiError extends Error {
  constructor(message, status, data) {
    super(message);
    this.status = status;
    this.data = data;
  }
}

function signedOut() {
  location.href = `/login?next=${encodeURIComponent(location.pathname + location.hash)}`;
}

/** JSON API call. opts: { method, body, timeoutMs, headers } */
export async function api(path, opts = {}, retried = false) {
  const init = { credentials: 'same-origin', headers: { 'X-Requested-With': 'sentry-six-manager', ...(opts.headers || {}) } };
  init.method = opts.method || (opts.body !== undefined ? 'POST' : 'GET');
  if (opts.body !== undefined) {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(opts.body);
  }
  const ctrl = opts.timeoutMs ? new AbortController() : null;
  const timer = ctrl ? setTimeout(() => ctrl.abort(), opts.timeoutMs) : null;
  if (ctrl) init.signal = ctrl.signal;
  let res;
  try {
    res = await fetch(path, init);
  } catch {
    clearTimeout(timer);
    throw new ApiError(ctrl?.signal.aborted ? 'The server took too long to answer.' : 'Can\'t reach the server. If the browser warns about the certificate, reload the page.', 0);
  }
  clearTimeout(timer);
  if (res.status === 401 && !path.startsWith('/api/auth/')) {
    signedOut();
    throw new ApiError('Signed out', 401);
  }
  const data = await res.json().catch(() => ({}));
  if (res.status === 403 && data.code === 'CONFIRM_PASSWORD' && !retried) {
    await confirmPassword();
    return api(path, opts, true);
  }
  if (!res.ok) throw new ApiError(data.error || `${res.status} ${res.statusText}`, res.status, data);
  return data;
}

/** A raw-body upload (support media, UI packs), with the password retry. */
export async function upload(path, body, headers) {
  const send = () => fetch(path, { method: 'POST', credentials: 'same-origin', body, headers: { 'X-Requested-With': 'sentry-six-manager', ...headers } });
  let res = await send();
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

/** Converter invoke: always resolves to the IPC envelope { ok, value | error }. */
export async function invoke(name, payload) {
  try {
    const res = await fetch(`/api/converter/invoke/${name}`, {
      method: 'POST', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'sentry-six-manager', 'X-Client-Id': CLIENT_ID },
      body: payload === undefined ? '' : JSON.stringify(payload)
    });
    if (res.status === 401) { signedOut(); return { ok: false, error: { code: 'SIGNED_OUT' } }; }
    const data = await res.json().catch(() => null);
    if (!res.ok || !data) return { ok: false, error: { code: data?.error || `HTTP_${res.status}` } };
    return data;
  } catch {
    return { ok: false, error: { code: 'NETWORK_ERROR' } };
  }
}

// ---------- shared state + bus ----------
export const state = {
  vehicles: [],
  vehicleId: store.get('vehicle', null),
  notes: [],
  power: null,
  system: null
};
export const current = () => state.vehicles.find((v) => v.id === state.vehicleId) || state.vehicles[0] || null;
export const sourceOf = (v) => (v ? v.studioRoot || v.root : null);

const listeners = new Map();
export const bus = {
  on(evt, fn) {
    if (!listeners.has(evt)) listeners.set(evt, new Set());
    listeners.get(evt).add(fn);
    return () => listeners.get(evt)?.delete(fn);
  },
  emit(evt, data) {
    for (const fn of [...(listeners.get(evt) || [])]) {
      try { fn(data); } catch (err) { console.warn(err); }
    }
  }
};

export function setVehicle(id) {
  if (!state.vehicles.some((v) => v.id === id)) return;
  state.vehicleId = id;
  store.set('vehicle', id);
  bus.emit('vehicle', id);
}

export async function loadVehicles() {
  const { vehicles } = await api('/api/vehicles');
  state.vehicles = vehicles;
  if (!state.vehicles.some((v) => v.id === state.vehicleId)) state.vehicleId = vehicles[0]?.id || null;
  bus.emit('vehicles', vehicles);
  return vehicles;
}

export async function loadNotes() {
  const { notifications } = await api('/api/notifications');
  state.notes = notifications;
  bus.emit('notes', notifications);
  return notifications;
}

/** Disables the button while fn runs; toasts errors. */
export async function busy(btn, fn) {
  if (btn) btn.disabled = true;
  try {
    return await fn();
  } catch (err) {
    if (err?.message !== 'Signed out') toast(err.message || String(err), 'bad');
    return undefined;
  } finally {
    if (btn && btn.isConnected) btn.disabled = false;
  }
}

/** Pretty, escaped, colourised JSON. */
export function jsonHtml(value) {
  const text = JSON.stringify(value, null, 2) ?? 'undefined';
  return esc(text).replace(/(&quot;(?:[^&]|&(?!quot;))*?&quot;)(\s*:)?|\b(true|false|null)\b|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/g, (m, str, colon, lit, n) => {
    if (str) return colon ? `<span class="j-key">${str}</span>${colon}` : `<span class="j-str">${str}</span>`;
    if (lit) return `<span class="j-lit">${lit}</span>`;
    return `<span class="j-num">${n}</span>`;
  });
}

/** Debounce. */
export function debounce(fn, ms) {
  let t = null;
  return (...a) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...a), ms);
  };
}

export const CATEGORY_COLORS = { Recent: 'cyan', Sentry: 'amber', Saved: 'green', Other: 'muted' };
export const CAMERAS = ['front', 'back', 'left_repeater', 'right_repeater', 'left_pillar', 'right_pillar'];
export const CAMERA_LABEL = { front: 'Front', back: 'Back', left_repeater: 'Left rep.', right_repeater: 'Right rep.', left_pillar: 'Left pillar', right_pillar: 'Right pillar' };
export const CAMERA_SHORT = { front: 'F', back: 'B', left_repeater: 'LR', right_repeater: 'RR', left_pillar: 'LP', right_pillar: 'RP' };
