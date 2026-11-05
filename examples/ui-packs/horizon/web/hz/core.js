// Horizon core: the JSON API client, number formatting, dialogs, toasts and
// the little shared state every page reads (vehicles, notifications).

export const qs = (sel, root = document) => root.querySelector(sel);
export const qsa = (sel, root = document) => [...root.querySelectorAll(sel)];
const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
/** Escapes any server text before it goes into HTML. */
export const h = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ESC[c]);
export const ok = (n) => typeof n === 'number' && Number.isFinite(n);
export const ico = (name, cls = 'i') => `<svg class="${cls}" aria-hidden="true" focusable="false"><use href="#g-${name}"/></svg>`;
export const motionOff = () => matchMedia('(prefers-reduced-motion: reduce)').matches || document.documentElement.classList.contains('calm-ui');

// ---------- per-browser settings ----------
export const local = {
  get(key, fallback) {
    try {
      const raw = localStorage.getItem(`horizon.${key}`);
      return raw === null ? fallback : JSON.parse(raw);
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    try { localStorage.setItem(`horizon.${key}`, JSON.stringify(value)); } catch { /* private window */ }
  }
};

// ---------- formatting ----------
const SIZES = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
export function size(n, digits = 1) {
  if (n === null || n === undefined || !ok(Number(n))) return '—';
  let v = Number(n);
  let i = 0;
  while (Math.abs(v) >= 1024 && i < SIZES.length - 1) { v /= 1024; i++; }
  return `${i ? v.toFixed(v >= 100 ? 0 : digits) : Math.round(v)} ${SIZES[i]}`;
}
export const perSec = (n) => (ok(n) ? `${size(n)}/s` : '—');
export const pc = (n, d = 0) => (ok(n) ? `${n.toFixed(d)}%` : '—');
export const fixed = (n, d = 0) => (ok(n) ? n.toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: d }) : '—');
export const count = (n, one, many = `${one}s`) => `${Number(n || 0).toLocaleString()} ${Number(n) === 1 ? one : many}`;
export function span(ms) {
  if (!ok(ms) || ms < 0) return '—';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}m`;
  return `${Math.floor(s / 86400)}d ${Math.floor((s % 86400) / 3600)}h`;
}
export function mmss(sec) {
  if (!ok(sec) || sec < 0) return '0:00';
  const m = Math.floor(sec / 60);
  return `${m}:${String(Math.floor(sec - m * 60)).padStart(2, '0')}`;
}
export function since(ts) {
  if (!ts) return 'never';
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 5) return 'just now';
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} d ago`;
}
/** 12- or 24-hour clock, from appearance.clock24 in /api/settings. */
export const clockPref = { h24: false };
export const hourOpts = (o = {}) => ({ ...o, hour: clockPref.h24 ? '2-digit' : 'numeric', hour12: !clockPref.h24 });
export const stamp = (ts) => (ts ? new Date(ts).toLocaleString(undefined, hourOpts({ month: 'short', day: 'numeric', minute: '2-digit' })) : '—');
export const stampFull = (ts) => (ts ? new Date(ts).toLocaleString(undefined, hourOpts({ year: 'numeric', month: 'short', day: 'numeric', minute: '2-digit', second: '2-digit' })) : '—');
/** A wall-clock time from car text ("2024-05-01 06:07:45", "…_06-07-45", "06:07:45") in the chosen clock. */
export function wall(s, secs = true) {
  const m = /(?:^|[ T_])(\d{1,2})[:-](\d{2})(?:[:-](\d{2}))?$/.exec(String(s || ''));
  if (!m) return String(s || '');
  const tail = `:${m[2]}${secs && m[3] ? `:${m[3]}` : ''}`;
  const hr = Number(m[1]);
  return clockPref.h24 ? `${String(hr).padStart(2, '0')}${tail}` : `${hr % 12 || 12}${tail} ${hr < 12 ? 'AM' : 'PM'}`;
}
export const wallDay = (s) => (s ? `${String(s).slice(0, 10)} ${wall(s)}` : '');
export const watt = (w) => (ok(w) ? `${w >= 10 ? Math.round(w) : w.toFixed(1)} W` : '—');
export const wh = (x) => (!ok(x) ? '—' : x < 1000 ? `${x.toFixed(x < 100 ? 1 : 0)} Wh` : `${(x / 1000).toFixed(2)} kWh`);
export function cash(v, cur = '$') {
  if (!ok(v)) return '—';
  const n = v >= 100 ? Math.round(v).toLocaleString() : v.toFixed(2);
  return /^[a-z]+$/i.test(cur) ? `${n} ${cur}` : `${cur}${n}`;
}
export const words = (s) => String(s || '').replace(/[_-]+/g, ' ').replace(/^\w/, (c) => c.toUpperCase());
export function dayName(day, long = false) {
  const d = new Date(`${day}T12:00:00`);
  if (Number.isNaN(d.getTime())) return day;
  return d.toLocaleDateString(undefined, long ? { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' } : { weekday: 'short', month: 'short', day: 'numeric' });
}
export const CAMS = ['front', 'back', 'left_repeater', 'right_repeater', 'left_pillar', 'right_pillar'];
export const CAM_NAME = { front: 'Front', back: 'Rear', left_repeater: 'Left repeater', right_repeater: 'Right repeater', left_pillar: 'Left pillar', right_pillar: 'Right pillar' };
export const CAM_TAG = { front: 'F', back: 'R', left_repeater: 'LR', right_repeater: 'RR', left_pillar: 'LP', right_pillar: 'RP' };
export const CODEC_NAME = { h264: 'H.264', h265: 'H.265', hevc: 'H.265', av1: 'AV1' };

// ---------- toasts ----------
export function toast(text, tone = 'ok') {
  const box = qs('#hz-toasts');
  if (!box) return;
  const el = document.createElement('div');
  el.className = `toast ${tone}`;
  el.setAttribute('role', tone === 'bad' ? 'alert' : 'status');
  el.innerHTML = `${ico(tone === 'bad' ? 'warn' : 'check')}<span></span>`;
  el.querySelector('span').textContent = text;
  box.append(el);
  setTimeout(() => {
    el.classList.add('gone');
    setTimeout(() => el.remove(), 320);
  }, tone === 'bad' ? 8000 : 4000);
}

// ---------- dialogs ----------
function modal(html, { wide = false, onOpen } = {}) {
  return new Promise((resolve) => {
    const dlg = qs('#hz-dlg');
    const form = qs('#hz-dlg-form');
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

export async function ask({ title, body = '', yes = 'OK', no = 'Cancel', danger = false }) {
  const { value } = await modal(`<header class="dlg-h"><h2>${h(title)}</h2></header><div class="dlg-b">${body}</div>
    <footer class="dlg-f"><button class="btn" value="no">${h(no)}</button><button class="btn ${danger ? 'danger' : 'go'}" value="yes" autofocus>${h(yes)}</button></footer>`);
  return value === 'yes';
}

export async function askText({ title, label, value = '', yes = 'Save', type = 'text', body = '', max = 200 }) {
  let input;
  const { value: v } = await modal(`<header class="dlg-h"><h2>${h(title)}</h2></header><div class="dlg-b">${body}
    <label class="fld">${h(label)}<input class="in" name="v" type="${h(type)}" maxlength="${max}" value="${h(value)}" autocomplete="${type === 'password' ? 'current-password' : 'off'}"></label></div>
    <footer class="dlg-f"><button class="btn" value="no" formnovalidate>Cancel</button><button class="btn go" value="yes">${h(yes)}</button></footer>`, {
    onOpen(form, dlg) {
      input = form.querySelector('input[name=v]');
      input.focus();
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); dlg.close('yes'); }
      });
    }
  });
  return v === 'yes' ? input.value : null;
}

export function sheet(title, html, { wide = true, onOpen } = {}) {
  return modal(`<header class="dlg-h"><h2>${h(title)}</h2><button class="btn icon ghost" value="close" aria-label="Close">${ico('x')}</button></header><div class="dlg-b">${html}</div>`, { wide, onOpen });
}

let confirming = null;
async function confirmPassword() {
  if (confirming) return confirming;
  confirming = (async () => {
    for (let i = 0; i < 3; i++) {
      const pw = await askText({
        title: 'Password check', label: 'Your password', type: 'password', yes: 'Confirm',
        body: `<p class="dim">${i ? 'That was not the right password. Try again.' : 'This change touches where footage comes from or what code runs, so the server wants your password once more.'}</p>`
      });
      if (!pw) throw new Error('Not changed: the password was not confirmed.');
      try {
        await api('/api/auth/confirm', { body: { password: pw } }, true);
        return;
      } catch (err) {
        if (/too many/i.test(err.message)) throw err;
      }
    }
    throw new Error('Not changed: the password was not confirmed.');
  })();
  try { return await confirming; } finally { confirming = null; }
}

// ---------- API ----------
export const CLIENT = (globalThis.crypto?.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`).slice(0, 64);
export class ApiError extends Error {
  constructor(message, status, data) {
    super(message);
    this.status = status;
    this.data = data;
  }
}
function toLogin() {
  location.href = `/login?next=${encodeURIComponent(location.pathname + location.hash)}`;
}

/** A JSON call. opts: { method, body, timeout, headers } */
export async function api(path, opts = {}, isRetry = false) {
  const init = { credentials: 'same-origin', headers: { 'X-Requested-With': 'sentry-six-manager', ...(opts.headers || {}) } };
  init.method = opts.method || (opts.body !== undefined ? 'POST' : 'GET');
  if (opts.body !== undefined) {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(opts.body);
  }
  const ctl = opts.timeout ? new AbortController() : null;
  const timer = ctl ? setTimeout(() => ctl.abort(), opts.timeout) : null;
  if (ctl) init.signal = ctl.signal;
  let res;
  try {
    res = await fetch(path, init);
  } catch {
    clearTimeout(timer);
    throw new ApiError(ctl?.signal.aborted ? 'The server took too long to answer.' : 'The server cannot be reached right now.', 0);
  }
  clearTimeout(timer);
  if (res.status === 401 && !path.startsWith('/api/auth/')) {
    toLogin();
    throw new ApiError('Signed out', 401);
  }
  const data = await res.json().catch(() => ({}));
  if (res.status === 403 && data.code === 'CONFIRM_PASSWORD' && !isRetry) {
    await confirmPassword();
    return api(path, opts, true);
  }
  if (!res.ok) throw new ApiError(data.error || `${res.status} ${res.statusText}`, res.status, data);
  return data;
}

/** A raw upload (interface packs), with the password re-check. */
export async function send(path, body, headers) {
  const go = () => fetch(path, { method: 'POST', credentials: 'same-origin', body, headers: { 'X-Requested-With': 'sentry-six-manager', ...headers } });
  let res = await go();
  let data = await res.json().catch(() => ({}));
  if (res.status === 403 && data.code === 'CONFIRM_PASSWORD') {
    await confirmPassword();
    res = await go();
    data = await res.json().catch(() => ({}));
  }
  if (res.status === 401) toLogin();
  if (!res.ok) throw new ApiError(data.error || `Upload failed (${res.status}).`, res.status, data);
  return data;
}

/** The converter: always resolves to { ok, value } or { ok: false, error }. */
export async function conv(name, payload, client = CLIENT) {
  try {
    const res = await fetch(`/api/converter/invoke/${name}`, {
      method: 'POST', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'sentry-six-manager', 'X-Client-Id': client },
      body: payload === undefined ? '' : JSON.stringify(payload)
    });
    if (res.status === 401) { toLogin(); return { ok: false, error: { code: 'SIGNED_OUT' } }; }
    const data = await res.json().catch(() => null);
    if (!res.ok || !data) return { ok: false, error: { code: data?.error || `HTTP_${res.status}` } };
    return data;
  } catch {
    return { ok: false, error: { code: 'NETWORK_ERROR' } };
  }
}

// ---------- shared state ----------
export const app = {
  vehicles: [],
  vehicleId: local.get('vehicle', null),
  notes: [],
  power: null,
  converter: null // last known converter state name
};
export const car = () => app.vehicles.find((v) => v.id === app.vehicleId) || app.vehicles[0] || null;
export const carRoot = (v) => (v ? v.studioRoot || v.root : null);

const subs = new Map();
export const bus = {
  on(name, fn) {
    if (!subs.has(name)) subs.set(name, new Set());
    subs.get(name).add(fn);
    return () => subs.get(name)?.delete(fn);
  },
  emit(name, data) {
    for (const fn of [...(subs.get(name) || [])]) {
      try { fn(data); } catch (err) { console.warn(err); }
    }
  }
};

export function pickCar(id) {
  if (!app.vehicles.some((v) => v.id === id)) return;
  app.vehicleId = id;
  local.set('vehicle', id);
  bus.emit('car', id);
}
export async function loadCars() {
  const { vehicles, footageDays } = await api('/api/vehicles');
  app.vehicles = vehicles;
  app.footageDays = footageDays;
  if (!vehicles.some((v) => v.id === app.vehicleId)) app.vehicleId = vehicles[0]?.id || null;
  bus.emit('cars', vehicles);
  return vehicles;
}
export async function loadNotes() {
  const { notifications } = await api('/api/notifications');
  app.notes = notifications;
  bus.emit('notes', notifications);
  return notifications;
}

/** Runs fn with the button disabled; failures become a toast. */
export async function act(btn, fn) {
  if (btn) btn.disabled = true;
  try {
    return await fn();
  } catch (err) {
    if (err?.message !== 'Signed out') toast(err?.message || String(err), 'bad');
    return undefined;
  } finally {
    if (btn && btn.isConnected) btn.disabled = false;
  }
}

export function debounce(fn, ms) {
  let t = 0;
  return (...a) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...a), ms);
  };
}

/** Sets innerHTML only when the markup changed, so a live refresh does not swap
 *  a button out from under a finger that is about to tap it. */
const painted = new WeakMap();
export function paint(node, html) {
  if (!node || painted.get(node) === html) return false;
  painted.set(node, html);
  node.innerHTML = html;
  return true;
}

// ---------- small shared pieces of markup ----------
/** A segmented control; wire it with tabs(). */
export function segs(name, items, current, label) {
  return `<div class="segs" role="radiogroup" aria-label="${h(label || name)}" data-segs="${h(name)}">${items.map(([v, l]) => `<button type="button" role="radio" data-v="${h(v)}" aria-checked="${String(v) === String(current)}" class="${String(v) === String(current) ? 'on' : ''}">${l}</button>`).join('')}</div>`;
}
export function onSegs(root, name, fn) {
  const box = root.querySelector(`[data-segs="${name}"]`);
  if (!box) return;
  box.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-v]');
    if (!b) return;
    box.querySelectorAll('button').forEach((x) => { x.classList.toggle('on', x === b); x.setAttribute('aria-checked', String(x === b)); });
    fn(b.dataset.v);
  });
}
export const pill = (text, tone = '') => `<span class="pill ${tone}">${h(text)}</span>`;
export const bar = (p, tone = '') => `<span class="bar ${tone}" role="presentation"><i style="width:${ok(p) ? Math.max(0, Math.min(100, p)).toFixed(1) : 0}%"></i></span>`;
export const blank = (text, extra = '') => `<div class="blank">${ico('horizon', 'i big')}<p>${text}</p>${extra}</div>`;
export const panelHead = (title, extra = '') => `<header class="ph"><h2>${title}</h2>${extra ? `<div class="ph-x">${extra}</div>` : ''}</header>`;

// ---------- live redraws and a highlight ----------
// Text the reader is highlighting (or about to, with the button down) inside
// a region: redrawing that region would take the highlight away before it
// can be copied. Live updates of it wait until the highlight is gone (mouse,
// Shift + arrows or Ctrl A alike), then catch up at once with the newest draw.
// A region is an element, a selector, a function returning one, or a list.
let pressing = null;
const heldDraws = new Map();
const regionNodes = (region) => (Array.isArray(region) ? region : [region])
  .map((x) => (typeof x === 'function' ? x() : typeof x === 'string' ? document.querySelector(x) : x))
  .filter(Boolean);
/** True while the reader is highlighting text inside `region` (or pressing to start). */
export function selecting(region) {
  const nodes = regionNodes(region);
  if (!nodes.length) return false;
  if (pressing && nodes.some((n) => n.contains(pressing))) return true;
  const sel = document.getSelection?.();
  if (!sel || sel.isCollapsed || !sel.rangeCount) return false;
  const range = sel.getRangeAt(0);
  return nodes.some((n) => n.contains(range.commonAncestorContainer) || range.intersectsNode?.(n) === true);
}
function runDraw(draw) {
  try {
    const out = draw();
    if (out && typeof out.catch === 'function') out.catch((err) => console.warn(err));
  } catch (err) { console.warn(err); }
}
/**
 * A live (timer, poll or server event) redraw of `region`: drawn now, or held
 * while the reader highlights text in it and drawn once the highlight is gone.
 * Held draws of the same `key` (the draw itself unless given) keep the newest.
 */
export function liveDraw(region, draw, key = draw) {
  if (selecting(region)) {
    heldDraws.set(key, { region, draw });
    return false;
  }
  heldDraws.delete(key);
  runDraw(draw);
  return true;
}
function catchUp() {
  for (const [key, h] of [...heldDraws]) {
    const nodes = regionNodes(h.region);
    if (!nodes.some((n) => n.isConnected)) { heldDraws.delete(key); continue; }
    if (selecting(h.region)) continue;
    heldDraws.delete(key);
    runDraw(h.draw);
  }
}
document.addEventListener('pointerdown', (e) => { pressing = e.button === 0 ? e.target : null; }, true);
document.addEventListener('pointerup', () => { pressing = null; setTimeout(catchUp, 0); }, true);
document.addEventListener('pointercancel', () => { pressing = null; setTimeout(catchUp, 0); }, true);
document.addEventListener('selectionchange', () => { if (!pressing) catchUp(); });
