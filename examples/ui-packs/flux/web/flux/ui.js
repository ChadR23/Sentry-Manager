// Flux UI helpers: resizable split panes, drawers, segmented controls.
import { store, esc } from './core.js';

/**
 * Makes `box` (with two element children) a resizable split.
 * The first pane's width is kept per `id` in this browser.
 */
export function split(box, { id, initial = 360, min = 220, max = 900 } = {}) {
  const [a, b] = box.children;
  box.classList.add('split');
  a.classList.add('pane', 'pane-a');
  b.classList.add('pane', 'pane-b');
  const gutter = document.createElement('div');
  gutter.className = 'gutter';
  gutter.tabIndex = 0;
  gutter.setAttribute('role', 'separator');
  gutter.setAttribute('aria-orientation', 'vertical');
  gutter.setAttribute('aria-label', 'Resize panes (arrow keys)');
  gutter.innerHTML = '<i></i>';
  box.insertBefore(gutter, b);
  let width = store.get(`split:${id}`, initial);
  const apply = () => {
    const room = box.clientWidth || 1200;
    width = Math.max(min, Math.min(Math.min(max, room - 320), width));
    box.style.setProperty('--split', `${Math.round(width)}px`);
    gutter.setAttribute('aria-valuenow', String(Math.round(width)));
  };
  apply();
  let startX = 0;
  let startW = 0;
  const move = (e) => {
    width = startW + (e.clientX - startX);
    apply();
  };
  const up = () => {
    box.classList.remove('dragging');
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
    store.set(`split:${id}`, Math.round(width));
    window.dispatchEvent(new Event('resize'));
  };
  gutter.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    startX = e.clientX;
    startW = a.getBoundingClientRect().width;
    box.classList.add('dragging');
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  });
  gutter.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    width += (e.key === 'ArrowLeft' ? -1 : 1) * (e.shiftKey ? 80 : 24);
    apply();
    store.set(`split:${id}`, Math.round(width));
  });
  gutter.addEventListener('dblclick', () => {
    width = initial;
    apply();
    store.set(`split:${id}`, Math.round(width));
  });
  return { gutter };
}

/** A segmented control's HTML: options [[value, label]] */
export function seg(name, options, value, label = '') {
  return `<div class="seg" role="radiogroup"${label ? ` aria-label="${esc(label)}"` : ''} data-seg="${esc(name)}">${options.map(([v, l]) => `<button type="button" role="radio" data-v="${esc(v)}" aria-checked="${String(v) === String(value)}" class="${String(v) === String(value) ? 'on' : ''}">${l}</button>`).join('')}</div>`;
}

/** Wire a segmented control: onChange(value). */
export function wireSeg(root, name, onChange) {
  const box = root.querySelector(`[data-seg="${name}"]`);
  if (!box) return;
  box.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-v]');
    if (!b) return;
    box.querySelectorAll('button').forEach((x) => {
      x.classList.toggle('on', x === b);
      x.setAttribute('aria-checked', String(x === b));
    });
    onChange(b.dataset.v);
  });
  box.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    const btns = [...box.querySelectorAll('button')];
    const i = btns.findIndex((x) => x.classList.contains('on'));
    const n = btns[(i + (e.key === 'ArrowRight' ? 1 : -1) + btns.length) % btns.length];
    n.focus();
    n.click();
    e.preventDefault();
  });
}

/** A slide-in drawer on the right. Returns { el, close }. */
export function drawer({ title, html, onClose, wide = false }) {
  document.querySelectorAll('.drawer').forEach((d) => d.remove());
  const el = document.createElement('aside');
  el.className = `drawer${wide ? ' wide' : ''}`;
  el.setAttribute('role', 'dialog');
  el.setAttribute('aria-label', title);
  el.innerHTML = `<div class="drawer-head"><h2>${esc(title)}</h2><button class="btn ghost icon" type="button" data-close aria-label="Close"><svg class="ico"><use href="#i-x"/></svg></button></div><div class="drawer-body">${html}</div>`;
  document.body.append(el);
  requestAnimationFrame(() => el.classList.add('open'));
  const prev = document.activeElement;
  const close = () => {
    el.classList.remove('open');
    setTimeout(() => el.remove(), 250);
    document.removeEventListener('keydown', onKey, true);
    onClose?.();
    if (prev && prev.isConnected) prev.focus({ preventScroll: true });
  };
  const onKey = (e) => {
    if (e.key === 'Escape' && !document.querySelector('dialog[open]')) {
      e.stopPropagation();
      close();
    }
  };
  document.addEventListener('keydown', onKey, true);
  el.querySelector('[data-close]').onclick = close;
  el.querySelector('[data-close]').focus({ preventScroll: true });
  return { el, close, body: el.querySelector('.drawer-body') };
}

/** Empty state block. */
export const empty = (text, extra = '') => `<div class="empty"><div class="empty-glyph" aria-hidden="true">∅</div><p>${text}</p>${extra}</div>`;

/** Chip HTML. */
export const chip = (text, tone = '') => `<span class="chip ${tone}">${esc(text)}</span>`;

/** A labelled meter bar. */
export const meter = (p, tone = '') => `<div class="meter ${tone}"><span style="width:${Math.max(0, Math.min(100, p || 0)).toFixed(1)}%"></span></div>`;
