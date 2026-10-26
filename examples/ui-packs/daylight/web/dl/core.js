// Daylight: shared helpers (API, formatting, dialogs, toasts, storage).
// Every piece of server text goes through esc() before it becomes HTML.

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
export const enc = encodeURIComponent;
export const fin = (n) => typeof n === 'number' && Number.isFinite(n);

// ---------- storage (per browser, a convenience only) ----------
export const store = {
  get(key, fallback) {
    try {
      const v = localStorage.getItem(`daylight:${key}`);
      return v === null ? fallback : JSON.parse(v);
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    try { localStorage.setItem(`daylight:${key}`, JSON.stringify(value)); } catch { /* private mode */ }
  }
};

// ---------- formatting ----------
const UNITS = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
export function bytes(n) {
  if (!fin(Number(n)) || n === null) return '—';
  let v = Math.abs(Number(n));
  let i = 0;
  while (v >= 1024 && i < UNITS.length - 1) { v /= 1024; i++; }
  const text = i === 0 ? String(Math.round(v)) : v >= 100 ? String(Math.round(v)) : v.toFixed(1).replace(/\.0$/, '');
  return `${n < 0 ? '-' : ''}${text} ${UNITS[i]}`;
}
export const plural = (n, word, many = `${word}s`) => `${Number(n || 0).toLocaleString()} ${Number(n) === 1 ? word : many}`;
export const pct = (n) => `${Math.round(n)}%`;
export function ago(ts) {
  if (!ts) return 'never';
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 45) return 'just now';
  if (s < 3600) return `${Math.max(1, Math.round(s / 60))} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  if (s < 7 * 86400) return `${Math.round(s / 86400)} d ago`;
  return new Date(ts).toLocaleDateString();
}
export const when = (ts) => (ts ? new Date(ts).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '—');
export function duration(ms) {
  if (!fin(ms) || ms < 0) return '—';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} s`;
  if (s < 3600) return `${Math.floor(s / 60)} min ${s % 60 ? `${s % 60} s` : ''}`.trim();
  const h = Math.floor(s / 3600);
  if (h < 48) return `${h} h ${Math.floor((s % 3600) / 60)} min`;
  return `${Math.floor(h / 24)} d ${h % 24} h`;
}
export const clockOf = (ms) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};
/** "Sunday, October 25" for a YYYY-MM-DD (shown as the car's local day). */
export const dayTitle = (day, opts = { weekday: 'long', month: 'long', day: 'numeric' }) => new Date(`${day}T12:00:00`).toLocaleDateString(undefined, opts);
export const dayShort = (day) => dayTitle(day, { weekday: 'short', month: 'short', day: 'numeric' });
/** "08:10" from "2026-10-25 08:10:02" */
export const hhmm = (s) => (s ? String(s).slice(11, 16) : '');
export const niceTime = (s) => {
  if (!s) return '';
  const [h, m] = String(s).slice(11, 16).split(':').map(Number);
  const d = new Date(2000, 0, 1, h, m);
  return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
};
export const CATEGORY = {
  Recent: { word: 'Drive', many: 'Drives', tone: 'teal' },
  Sentry: { word: 'Sentry event', many: 'Sentry events', tone: 'amber' },
  Saved: { word: 'Saved clip', many: 'Saved clips', tone: 'violet' },
  Other: { word: 'Other', many: 'Other', tone: 'grey' }
};
export const CODEC = { h264: 'H.264', h265: 'H.265', av1: 'AV1' };
export const humanize = (s) => String(s || '').replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase());

// ---------- the API ----------
const XRW = { 'X-Requested-With': 'sentry-six-manager' };

function signIn() {
  const next = location.pathname + location.search + location.hash;
  location.href = `/login?next=${enc(next)}`;
}

export class ApiError extends Error {
  constructor(message, status, code) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

/** JSON request; asks for the password again when the server wants it. */
export async function api(path, opts = {}, retried = false) {
  const init = { credentials: 'same-origin', headers: { ...(opts.headers || {}) } };
  const method = opts.method || (opts.body !== undefined ? 'POST' : 'GET');
  init.method = method;
  if (method !== 'GET' && method !== 'HEAD') Object.assign(init.headers, XRW);
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
    if (ctrl?.signal.aborted) throw new ApiError('The server took too long to answer.', 0);
    throw new ApiError('Can’t reach Sentry Six Manager right now. Check your connection and try again.', 0);
  }
  clearTimeout(timer);
  if (res.status === 401 && !path.startsWith('/api/auth/')) {
    signIn();
    throw new ApiError('Signed out', 401);
  }
  const data = await res.json().catch(() => ({}));
  if (res.status === 403 && data.code === 'CONFIRM_PASSWORD' && !retried) {
    await confirmPassword();
    return api(path, opts, true);
  }
  if (!res.ok) throw new ApiError(data.error || res.statusText || `Error ${res.status}`, res.status, data.code);
  return data;
}

/** Raw body upload (a file), same rules as api(). */
export async function upload(path, file, headers = {}, retried = false) {
  let res;
  try {
    res = await fetch(path, { method: 'POST', credentials: 'same-origin', body: file, headers: { ...XRW, ...headers } });
  } catch {
    throw new ApiError('The upload could not reach the server.', 0);
  }
  if (res.status === 401) {
    signIn();
    throw new ApiError('Signed out', 401);
  }
  const data = await res.json().catch(() => ({}));
  if (res.status === 403 && data.code === 'CONFIRM_PASSWORD' && !retried) {
    await confirmPassword();
    return upload(path, file, headers, true);
  }
  if (!res.ok) throw new ApiError(data.error || `Upload failed (${res.status}).`, res.status);
  return data;
}

// ---------- the converter ----------
export const clientId = (crypto.randomUUID ? crypto.randomUUID() : String(Math.random()).slice(2)).slice(0, 64);
export class ConverterError extends Error {
  constructor(code, details) {
    super(code);
    this.code = code;
    this.details = details;
  }
}
/** One converter call; resolves with its value or throws ConverterError. */
export async function invoke(name, payload) {
  const out = await api(`/api/converter/invoke/${name}`, { method: 'POST', body: payload === undefined ? undefined : payload, headers: { 'X-Client-Id': clientId } });
  if (!out || out.ok !== true) throw new ConverterError(out?.error?.code || 'OPERATION_FAILED', out?.error?.details);
  return out.value;
}

// ---------- dialogs ----------
let dialogEl = null;
function dialogBox() {
  if (!dialogEl) {
    dialogEl = document.createElement('dialog');
    dialogEl.className = 'dlg';
    document.body.append(dialogEl);
  }
  return dialogEl;
}

/**
 * A modal. body is HTML (already escaped by the caller); buttons are
 * [{ label, value, kind }]. Resolves with the value of the button pressed
 * (and the form, for inputs), or null when closed.
 */
export function modal({ title, body, buttons = [{ label: 'OK', value: 'ok', kind: 'primary' }], wide = false, onOpen }) {
  return new Promise((resolve) => {
    const dlg = dialogBox();
    dlg.classList.toggle('wide', wide);
    dlg.innerHTML = `<form method="dialog" class="dlg-form">
      <div class="dlg-head"><h2 id="dlg-title">${esc(title)}</h2>
        <button type="button" class="icon-btn dlg-x" aria-label="Close">${ICON.close}</button></div>
      <div class="dlg-body">${body}</div>
      <div class="dlg-foot">${buttons.map((b) => `<button class="btn ${b.kind ? `btn-${b.kind}` : ''}" value="${esc(b.value)}"${b.kind === 'primary' || b.kind === 'danger' ? ' data-default' : ''}>${esc(b.label)}</button>`).join('')}</div>
    </form>`;
    dlg.setAttribute('aria-labelledby', 'dlg-title');
    const form = dlg.querySelector('form');
    dlg.querySelector('.dlg-x').onclick = () => dlg.close('');
    form.addEventListener('submit', (e) => {
      // Enter in a field picks the default button
      if (!e.submitter) {
        e.preventDefault();
        dlg.close(dlg.querySelector('[data-default]')?.value || 'ok');
      }
    });
    dlg.onclose = () => {
      const value = dlg.returnValue || null;
      resolve(value ? { value, form } : null);
    };
    dlg.returnValue = '';
    dlg.showModal();
    const first = dlg.querySelector('input, select, textarea');
    (first || dlg.querySelector('[data-default]') || dlg.querySelector('.dlg-x'))?.focus();
    onOpen?.(dlg);
  });
}

export async function confirmDialog({ title, body, ok = 'Confirm', cancel = 'Cancel', danger = false }) {
  const out = await modal({ title, body, buttons: [{ label: cancel, value: 'cancel' }, { label: ok, value: 'ok', kind: danger ? 'danger' : 'primary' }] });
  return out?.value === 'ok';
}

export async function promptDialog({ title, label, value = '', ok = 'Save', note = '', type = 'text', autocomplete = 'off' }) {
  const out = await modal({
    title,
    body: `<label class="field"><span>${esc(label)}</span><input class="input" name="v" type="${type}" value="${esc(value)}" autocomplete="${autocomplete}"></label>${note ? `<p class="muted small">${note}</p>` : ''}`,
    buttons: [{ label: 'Cancel', value: 'cancel' }, { label: ok, value: 'ok', kind: 'primary' }]
  });
  if (out?.value !== 'ok') return null;
  return out.form.querySelector('[name=v]').value;
}

let confirming = null;
/** Ask for the password and confirm it with the server; throws when cancelled. */
export function confirmPassword() {
  confirming ||= (async () => {
    try {
      for (let attempt = 0; attempt < 3; attempt++) {
        const out = await modal({
          title: 'Confirm it’s you',
          body: `<p>${attempt ? '<b>That password wasn’t right.</b> Try again.' : 'This change affects where footage comes from or what runs on the server, so we ask for your password once more.'}</p>
            <label class="field"><span>Password</span><input class="input" type="password" name="pw" autocomplete="current-password" required></label>`,
          buttons: [{ label: 'Cancel', value: 'cancel' }, { label: 'Confirm', value: 'ok', kind: 'primary' }]
        });
        const password = out?.value === 'ok' ? out.form.querySelector('[name=pw]').value : null;
        if (!password) throw new ApiError('Not changed: the password was not confirmed.', 403);
        try {
          await api('/api/auth/confirm', { body: { password } }, true);
          return;
        } catch (err) {
          if (err.status === 429) throw err;
        }
      }
      throw new ApiError('Not changed: the password was not confirmed.', 403);
    } finally {
      confirming = null;
    }
  })();
  return confirming;
}

// ---------- toasts ----------
export function toast(message, { kind = 'info', action = null, timeout } = {}) {
  let host = document.getElementById('toasts');
  if (!host) {
    host = document.createElement('div');
    host.id = 'toasts';
    host.setAttribute('role', 'status');
    host.setAttribute('aria-live', 'polite');
    document.body.append(host);
  }
  const el = document.createElement('div');
  el.className = `toast toast-${kind}`;
  const text = document.createElement('span');
  text.textContent = message;
  el.append(text);
  const close = () => {
    el.classList.add('leaving');
    setTimeout(() => el.remove(), 220);
  };
  if (action) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'toast-action';
    b.textContent = action.label;
    b.onclick = async () => {
      b.disabled = true;
      close();
      await action.run();
    };
    el.append(b);
  }
  const x = document.createElement('button');
  x.type = 'button';
  x.className = 'toast-x';
  x.setAttribute('aria-label', 'Dismiss');
  x.innerHTML = ICON.close;
  x.onclick = close;
  el.append(x);
  host.append(el);
  setTimeout(close, timeout ?? (action ? 9000 : kind === 'bad' ? 9000 : 5000));
}
export const fail = (err) => {
  if (err?.status === 401) return;
  toast(err?.message || String(err), { kind: 'bad' });
};

// ---------- icons (inline, stroked) ----------
const svg = (d, extra = '') => `<svg class="ic" viewBox="0 0 24 24" aria-hidden="true" focusable="false"${extra}>${d}</svg>`;
export const ICON = {
  home: svg('<path d="M3 11.5 12 4l9 7.5"/><path d="M5.5 10v9.5h13V10"/><path d="M10 19.5v-5h4v5"/>'),
  film: svg('<rect x="3" y="4" width="18" height="16" rx="2.5"/><path d="M3 9h18M3 15h18M8 4v16M16 4v16"/>'),
  play: svg('<path d="M7 4.5v15l12.5-7.5z" fill="currentColor" stroke="none"/>'),
  pause: svg('<rect x="6" y="4.5" width="4" height="15" rx="1" fill="currentColor" stroke="none"/><rect x="14" y="4.5" width="4" height="15" rx="1" fill="currentColor" stroke="none"/>'),
  playOutline: svg('<circle cx="12" cy="12" r="9"/><path d="M10 8.5v7l6-3.5z" fill="currentColor"/>'),
  encoder: svg('<path d="M4 7h10M4 12h16M4 17h7"/><path d="M17 4l3 3-3 3"/><path d="M14 14l3 3-3 3"/>'),
  more: svg('<circle cx="5" cy="12" r="1.6" fill="currentColor"/><circle cx="12" cy="12" r="1.6" fill="currentColor"/><circle cx="19" cy="12" r="1.6" fill="currentColor"/>'),
  bell: svg('<path d="M6 16V11a6 6 0 0 1 12 0v5l1.5 2h-15z"/><path d="M10 20.5a2.2 2.2 0 0 0 4 0"/>'),
  trash: svg('<path d="M4 7h16M9.5 7V4.5h5V7M6.5 7l1 13h9l1-13"/>'),
  restore: svg('<path d="M4 12a8 8 0 1 0 2.4-5.7"/><path d="M4 4v5h5"/>'),
  shield: svg('<path d="M12 3.5 5 6v5.5c0 4.4 3 7.6 7 9 4-1.4 7-4.6 7-9V6z"/>'),
  shieldCheck: svg('<path d="M12 3.5 5 6v5.5c0 4.4 3 7.6 7 9 4-1.4 7-4.6 7-9V6z"/><path d="m9 12 2.2 2.2L15.5 10"/>'),
  lock: svg('<rect x="5" y="10.5" width="14" height="10" rx="2"/><path d="M8 10.5V8a4 4 0 0 1 8 0v2.5"/>'),
  unlock: svg('<rect x="5" y="10.5" width="14" height="10" rx="2"/><path d="M8 10.5V8a4 4 0 0 1 7.6-1.7"/>'),
  disk: svg('<ellipse cx="12" cy="6.5" rx="7.5" ry="3"/><path d="M4.5 6.5v11c0 1.7 3.4 3 7.5 3s7.5-1.3 7.5-3v-11"/><path d="M4.5 12c0 1.7 3.4 3 7.5 3s7.5-1.3 7.5-3"/>'),
  check: svg('<path d="m5 12.5 4.5 4.5L19 7.5"/>'),
  checkCircle: svg('<circle cx="12" cy="12" r="9"/><path d="m8 12.3 2.8 2.8L16.2 9.7"/>'),
  alert: svg('<path d="M12 4 2.8 19.5h18.4z"/><path d="M12 10v4.5M12 17.2v.1"/>'),
  info: svg('<circle cx="12" cy="12" r="9"/><path d="M12 11v5.5M12 7.8v.1"/>'),
  close: svg('<path d="M6 6l12 12M18 6 6 18"/>'),
  back: svg('<path d="M15 5l-7 7 7 7"/>'),
  next: svg('<path d="M9 5l7 7-7 7"/>'),
  prevClip: svg('<path d="M6 5v14"/><path d="M18.5 5.5 9 12l9.5 6.5z" fill="currentColor"/>'),
  nextClip: svg('<path d="M18 5v14"/><path d="M5.5 5.5 15 12l-9.5 6.5z" fill="currentColor"/>'),
  plus: svg('<path d="M12 5v14M5 12h14"/>'),
  minus: svg('<path d="M5 12h14"/>'),
  car: svg('<path d="M4 15.5V12l2-5h12l2 5v3.5"/><path d="M3 15.5h18v3H3z"/><circle cx="7.5" cy="18.5" r="1.5"/><circle cx="16.5" cy="18.5" r="1.5"/><path d="M6 12h12"/>'),
  server: svg('<rect x="3.5" y="4" width="17" height="7" rx="2"/><rect x="3.5" y="13" width="17" height="7" rx="2"/><path d="M7 7.5h.01M7 16.5h.01"/>'),
  nodes: svg('<rect x="2.5" y="3.5" width="8" height="6" rx="1.5"/><rect x="13.5" y="14.5" width="8" height="6" rx="1.5"/><path d="M6.5 9.5v5.5h7M17.5 14.5V9h-7"/>'),
  rules: svg('<path d="M8 6h12M8 12h12M8 18h12"/><path d="m3.5 6 1 1 2-2M3.5 12l1 1 2-2M3.5 18l1 1 2-2"/>'),
  activity: svg('<path d="M3 12h4l3-7 4 14 3-7h4"/>'),
  chat: svg('<path d="M4 5.5h16v11H9l-5 4z"/>'),
  gear: svg('<circle cx="12" cy="12" r="3"/><path d="M12 2.8v2.4M12 18.8v2.4M21.2 12h-2.4M5.2 12H2.8M18.5 5.5l-1.7 1.7M7.2 16.8l-1.7 1.7M18.5 18.5l-1.7-1.7M7.2 7.2 5.5 5.5"/>'),
  sun: svg('<circle cx="12" cy="12" r="4"/><path d="M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5.3 5.3l1.4 1.4M17.3 17.3l1.4 1.4M5.3 18.7l1.4-1.4M17.3 6.7l1.4-1.4"/>'),
  moon: svg('<path d="M19.5 14.5A8 8 0 0 1 9.5 4.5a8 8 0 1 0 10 10z"/>'),
  auto: svg('<circle cx="12" cy="12" r="8.5"/><path d="M12 3.5v17" /><path d="M12 3.5a8.5 8.5 0 0 1 0 17z" fill="currentColor"/>'),
  refresh: svg('<path d="M20 11a8 8 0 1 0-2.3 5.7"/><path d="M20 4.5V11h-6.5"/>'),
  download: svg('<path d="M12 4v11M7 10.5l5 5 5-5"/><path d="M5 19.5h14"/>'),
  upload: svg('<path d="M12 16V5M7 9.5l5-5 5 5"/><path d="M5 19.5h14"/>'),
  calendar: svg('<rect x="3.5" y="5" width="17" height="15" rx="2"/><path d="M3.5 9.5h17M8 3v4M16 3v4"/>'),
  grid: svg('<rect x="3.5" y="4" width="7.5" height="7" rx="1.3"/><rect x="13" y="4" width="7.5" height="7" rx="1.3"/><rect x="3.5" y="13" width="7.5" height="7" rx="1.3"/><rect x="13" y="13" width="7.5" height="7" rx="1.3"/>'),
  expand: svg('<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>'),
  clock: svg('<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>'),
  sparkle: svg('<path d="M12 3.5l1.8 5.2 5.2 1.8-5.2 1.8L12 17.5l-1.8-5.2L5 10.5l5.2-1.8z"/>'),
  bolt: svg('<path d="M13 2.5 5 13.5h6l-1 8 8-11h-6z"/>'),
  folder: svg('<path d="M3.5 6.5a1.5 1.5 0 0 1 1.5-1.5h4.5l2 2.5h7.5a1.5 1.5 0 0 1 1.5 1.5v9a1.5 1.5 0 0 1-1.5 1.5H5a1.5 1.5 0 0 1-1.5-1.5z"/>'),
  network: svg('<rect x="9" y="3" width="6" height="5" rx="1"/><rect x="3" y="16" width="6" height="5" rx="1"/><rect x="15" y="16" width="6" height="5" rx="1"/><path d="M12 8v4M6 16v-4h12v4"/>'),
  key: svg('<circle cx="8" cy="15" r="4"/><path d="m11 12 8.5-8.5M16 7l2.5 2.5M14 9l1.5 1.5"/>'),
  palette: svg('<path d="M12 3.5a8.5 8.5 0 1 0 0 17c1.4 0 2-1 1.6-2.1-.5-1.2.3-2.4 1.6-2.4h1.8a3.5 3.5 0 0 0 3.5-3.5C20.5 7 16.7 3.5 12 3.5z"/><circle cx="7.5" cy="11" r="1.2" fill="currentColor"/><circle cx="10.5" cy="7.5" r="1.2" fill="currentColor"/><circle cx="15" cy="7.5" r="1.2" fill="currentColor"/>'),
  logout: svg('<path d="M14 4.5H6.5v15H14"/><path d="M10.5 12h10M17 8.5l3.5 3.5-3.5 3.5"/>'),
  select: svg('<rect x="4" y="4" width="16" height="16" rx="3"/><path d="m8.5 12 2.5 2.5 4.5-5"/>'),
  speed: svg('<path d="M4.5 17a8 8 0 1 1 15 0"/><path d="M12 13l4-4"/>'),
  attach: svg('<path d="M20 11.5l-8 8a5 5 0 0 1-7-7l8.5-8.5a3.3 3.3 0 0 1 4.7 4.7L9.7 17.2a1.7 1.7 0 0 1-2.4-2.4L15 7"/>'),
  send: svg('<path d="M4 12 20 4l-5 16-3-6.5z"/><path d="m12 13.5 8-9.5"/>')
};
export const icon = (name) => ICON[name] || '';

// ---------- small render helpers ----------
export function chip(text, tone = 'grey', iconName = '') {
  return `<span class="chip chip-${tone}">${iconName ? icon(iconName) : ''}${esc(text)}</span>`;
}
export function meter(fraction, tone = '') {
  const v = Math.max(0, Math.min(1, fin(fraction) ? fraction : 0));
  return `<div class="meter ${tone}" role="presentation"><span style="width:${(v * 100).toFixed(1)}%"></span></div>`;
}
export function emptyState({ art = 'sparkle', title, text = '', action = '' }) {
  return `<div class="empty"><div class="empty-art">${icon(art)}</div><h3>${esc(title)}</h3>${text ? `<p>${text}</p>` : ''}${action}</div>`;
}
export const details = (summary, body, open = false) => `<details class="more"${open ? ' open' : ''}><summary>${esc(summary)}</summary><div class="more-body">${body}</div></details>`;
export const kv = (rows) => `<dl class="kv">${rows.filter((r) => r && r[1] !== undefined && r[1] !== null && r[1] !== '').map(([k, v]) => `<dt>${esc(k)}</dt><dd>${v}</dd>`).join('')}</dl>`;
export const spinner = () => '<span class="spin" aria-hidden="true"></span>';
export const loading = (text = 'Loading…') => `<div class="loading">${spinner()}<span>${esc(text)}</span></div>`;

/** Disable a button while an async action runs. */
export async function busy(btn, fn) {
  if (btn) btn.disabled = true;
  try {
    return await fn();
  } finally {
    if (btn && btn.isConnected) btn.disabled = false;
  }
}

export const reducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches || document.documentElement.classList.contains('calm');
