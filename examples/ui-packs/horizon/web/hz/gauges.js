// Horizon instruments: SVG speedometer / tachometer dials, a fuel gauge, a lap
// ring and sparklines. Each is built once and then updated in place, so only a
// transform or a few attributes change per update.
import { h, ok } from './core.js';

const P = (cx, cy, r, deg) => {
  const a = (deg * Math.PI) / 180;
  return [cx + r * Math.cos(a), cy + r * Math.sin(a)];
};
function arc(cx, cy, r, from, to) {
  const [x0, y0] = P(cx, cy, r, from);
  const [x1, y1] = P(cx, cy, r, to);
  return `M${x0.toFixed(2)} ${y0.toFixed(2)}A${r} ${r} 0 ${to - from > 180 ? 1 : 0} 1 ${x1.toFixed(2)} ${y1.toFixed(2)}`;
}

let uid = 0;
/**
 * A round dial (270° sweep). opts: { max, majors, label, unit, red (0..1 where the
 * red zone starts), fmt (tick label) }. Returns markup; update with setDial().
 */
export function dial({ max = 100, majors = 10, label = '', unit = '', red = null, fmt = (v) => String(v), cls = '' } = {}) {
  const id = `dl${++uid}`;
  const S = 135;
  const SW = 270;
  let ticks = '';
  for (let i = 0; i <= majors * 5; i++) {
    const f = i / (majors * 5);
    const a = S + SW * f;
    const major = i % 5 === 0;
    const [x0, y0] = P(100, 100, major ? 70 : 74, a);
    const [x1, y1] = P(100, 100, 80, a);
    const hot = red !== null && f >= red;
    ticks += `<line x1="${x0.toFixed(1)}" y1="${y0.toFixed(1)}" x2="${x1.toFixed(1)}" y2="${y1.toFixed(1)}" class="${major ? 'tk-maj' : 'tk-min'}${hot ? ' tk-hot' : ''}"/>`;
    if (major) {
      const [tx, ty] = P(100, 100, 58, a);
      ticks += `<text x="${tx.toFixed(1)}" y="${(ty + 4).toFixed(1)}" class="tk-lab${hot ? ' tk-hot' : ''}">${h(fmt((max * f)))}</text>`;
    }
  }
  return `<div class="dial ${cls}" data-dial data-max="${max}">
    <svg viewBox="0 0 200 200" role="img" aria-labelledby="${id}-t">
      <title id="${id}-t">${h(label)}</title>
      <defs><linearGradient id="${id}-g" x1="0" y1="1" x2="1" y2="0"><stop offset="0" stop-color="#3df0ff"/><stop offset=".6" stop-color="#ff3fb4"/><stop offset="1" stop-color="#ff8a3d"/></linearGradient></defs>
      <circle cx="100" cy="100" r="92" class="dial-bezel"/>
      <path d="${arc(100, 100, 86, S, S + SW)}" class="dial-track"/>
      ${red !== null ? `<path d="${arc(100, 100, 86, S + SW * red, S + SW)}" class="dial-red"/>` : ''}
      <path d="${arc(100, 100, 86, S, S + 0.01)}" class="dial-val" stroke="url(#${id}-g)" data-val/>
      ${ticks}
      <g class="needle" data-needle style="transform: rotate(${S}deg)"><path d="M100 96.5 L176 100 L100 103.5 Z"/><circle cx="100" cy="100" r="9"/></g>
    </svg>
    <div class="dial-read"><b class="num" data-read>—</b><span data-unit>${h(unit)}</span></div>
    <div class="dial-label">${h(label)}</div>
  </div>`;
}
export function setDial(root, value, read, sub) {
  const el = root?.matches?.('[data-dial]') ? root : root?.querySelector('[data-dial]');
  if (!el) return;
  const max = Number(el.dataset.max) || 100;
  const f = ok(value) ? Math.max(0, Math.min(1, value / max)) : 0;
  const deg = 135 + 270 * f;
  el.querySelector('[data-needle]').style.transform = `rotate(${deg.toFixed(2)}deg)`;
  el.querySelector('[data-val]').setAttribute('d', arc(100, 100, 86, 135, 135 + Math.max(0.01, 270 * f)));
  el.querySelector('[data-read]').textContent = read ?? (ok(value) ? String(Math.round(value)) : '—');
  if (sub !== undefined) el.querySelector('[data-unit]').textContent = sub;
  el.classList.toggle('hot', f >= 0.9);
}

/** The fuel gauge: free space, E to F. */
export function fuel(label = 'Free space') {
  const id = `fu${++uid}`;
  let marks = '';
  for (let i = 0; i <= 4; i++) {
    const a = 210 + (120 * i) / 4;
    const [x0, y0] = P(100, 110, 70, a);
    const [x1, y1] = P(100, 110, 82, a);
    marks += `<line x1="${x0.toFixed(1)}" y1="${y0.toFixed(1)}" x2="${x1.toFixed(1)}" y2="${y1.toFixed(1)}" class="${i === 0 ? 'tk-maj tk-hot' : 'tk-maj'}"/>`;
  }
  const [ex, ey] = P(100, 110, 56, 214);
  const [fx, fy] = P(100, 110, 56, 326);
  return `<div class="fuel" data-fuel>
    <svg viewBox="0 30 200 110" role="img" aria-labelledby="${id}-t"><title id="${id}-t">${h(label)}</title>
      <path d="${arc(100, 110, 86, 210, 330)}" class="dial-track"/>
      <path d="${arc(100, 110, 86, 210, 222)}" class="dial-red"/>
      ${marks}
      <text x="${ex.toFixed(1)}" y="${(ey + 5).toFixed(1)}" class="fuel-e">E</text><text x="${fx.toFixed(1)}" y="${(fy + 5).toFixed(1)}" class="fuel-f">F</text>
      <g class="needle" data-needle style="transform: rotate(210deg); transform-origin: 100px 110px"><path d="M100 107 L178 110 L100 113 Z"/><circle cx="100" cy="110" r="8"/></g>
    </svg>
    <div class="fuel-read"><b class="num" data-read>—</b><span data-sub></span></div>
  </div>`;
}
export function setFuel(root, frac, read, sub) {
  const el = root?.querySelector('[data-fuel]');
  if (!el) return;
  const f = ok(frac) ? Math.max(0, Math.min(1, frac)) : 0;
  el.querySelector('[data-needle]').style.transform = `rotate(${(210 + 120 * f).toFixed(2)}deg)`;
  el.querySelector('[data-read]').textContent = read;
  el.querySelector('[data-sub]').textContent = sub || '';
  el.classList.toggle('low', ok(frac) && f < 0.1);
}

/** A ring that fills (the lap counter). */
export function ring(label = '') {
  const C = 2 * Math.PI * 52;
  return `<div class="ring" data-ring><svg viewBox="0 0 120 120" aria-hidden="true"><circle cx="60" cy="60" r="52" class="ring-track"/><circle cx="60" cy="60" r="52" class="ring-val" data-arc stroke-dasharray="${C.toFixed(1)}" stroke-dashoffset="${C.toFixed(1)}" transform="rotate(-90 60 60)"/></svg>
    <div class="ring-in"><span class="ring-lab">${h(label)}</span><b class="num" data-read>—</b><span class="num" data-sub></span></div></div>`;
}
export function setRing(root, frac, read, sub) {
  const el = root?.querySelector('[data-ring]');
  if (!el) return;
  const C = 2 * Math.PI * 52;
  const f = ok(frac) ? Math.max(0, Math.min(1, frac)) : 0;
  el.querySelector('[data-arc]').setAttribute('stroke-dashoffset', (C * (1 - f)).toFixed(1));
  el.querySelector('[data-read]').textContent = read;
  el.querySelector('[data-sub]').textContent = sub || '';
}

/** A sparkline; values may contain nulls. */
export function spark(values, { w = 160, h: ht = 36, max = null, tone = 'cyan' } = {}) {
  const v = values.filter(ok);
  if (v.length < 2) return `<svg class="spark ${tone}" viewBox="0 0 ${w} ${ht}" preserveAspectRatio="none" aria-hidden="true"><line x1="0" y1="${ht - 1}" x2="${w}" y2="${ht - 1}" class="sp-base"/></svg>`;
  const top = max ?? (Math.max(...v) * 1.1 || 1);
  const n = values.length;
  let d = '';
  let pen = false;
  values.forEach((x, i) => {
    if (!ok(x)) { pen = false; return; }
    const px = (i / (n - 1)) * w;
    const py = ht - 2 - (Math.min(x, top) / top) * (ht - 4);
    d += `${pen ? 'L' : 'M'}${px.toFixed(1)} ${py.toFixed(1)}`;
    pen = true;
  });
  return `<svg class="spark ${tone}" viewBox="0 0 ${w} ${ht}" preserveAspectRatio="none" aria-hidden="true"><path d="${d}" class="sp-line"/></svg>`;
}
