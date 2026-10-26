// Flux charts: small canvas time-series charts with hover readouts. No libraries.
import { esc, fin } from './core.js';

export const C = {
  violet: '#a57cff', cyan: '#5fd6ec', green: '#5fdc9a', amber: '#f2c25b', red: '#ff7a6b', pink: '#ff86c4',
  blue: '#6ea8ff', lime: '#b9e66b', orange: '#ff9f5a', teal: '#3fc7b5', grid: 'rgba(160,160,200,0.10)', axis: 'rgba(200,200,230,0.55)'
};
export const PALETTE = [C.violet, C.cyan, C.green, C.amber, C.pink, C.blue, C.orange, C.teal, C.lime, C.red];

function niceMax(v) {
  if (!(v > 0)) return 1;
  const p = 10 ** Math.floor(Math.log10(v));
  const n = v / p;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10) * p;
}

/**
 * new TimeChart(host, { series: [{ key, label, color, fill }], format, max, min, stacked, height })
 * chart.set(times[], { key: values[] })
 */
export class TimeChart {
  constructor(host, opts) {
    this.host = host;
    this.opts = { height: 120, min: 0, format: (v) => String(Math.round(v)), timeFormat: null, ...opts };
    host.classList.add('tchart');
    host.innerHTML = '<canvas></canvas><div class="tc-tip" hidden></div><div class="tc-legend"></div>';
    this.canvas = host.querySelector('canvas');
    this.tip = host.querySelector('.tc-tip');
    this.legend = host.querySelector('.tc-legend');
    this.ctx = this.canvas.getContext('2d');
    this.times = [];
    this.data = {};
    this.hover = null;
    this.hidden = new Set();
    this.drawLegend();
    this.ro = new ResizeObserver(() => this.draw());
    this.ro.observe(host);
    this.onMove = (e) => {
      const r = this.canvas.getBoundingClientRect();
      this.hover = { x: e.clientX - r.left, y: e.clientY - r.top };
      this.draw();
    };
    this.onLeave = () => { this.hover = null; this.tip.hidden = true; this.draw(); };
    this.canvas.addEventListener('pointermove', this.onMove);
    this.canvas.addEventListener('pointerdown', this.onMove);
    this.canvas.addEventListener('pointerleave', this.onLeave);
  }

  setSeries(series) {
    this.opts.series = series;
    this.drawLegend();
    this.draw();
  }

  drawLegend() {
    const s = this.opts.series || [];
    if (s.length < 2 && !this.opts.legend) { this.legend.innerHTML = ''; return; }
    this.legend.innerHTML = s.map((x) => `<button type="button" class="tc-key${this.hidden.has(x.key) ? ' off' : ''}" data-k="${esc(x.key)}" aria-pressed="${!this.hidden.has(x.key)}"><i style="background:${x.color}"></i>${esc(x.label)}</button>`).join('');
    this.legend.querySelectorAll('[data-k]').forEach((b) => {
      b.onclick = () => {
        const k = b.dataset.k;
        if (this.hidden.has(k)) this.hidden.delete(k); else this.hidden.add(k);
        this.drawLegend();
        this.draw();
      };
    });
  }

  set(times, data) {
    this.times = times;
    this.data = data;
    this.draw();
  }

  destroy() {
    this.ro.disconnect();
  }

  draw() {
    const { canvas, ctx, opts } = this;
    const w = this.host.clientWidth;
    const h = opts.height;
    if (!w) return;
    const dpr = window.devicePixelRatio || 1;
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      canvas.style.width = `${w}px`;
      canvas.style.height = `${h}px`;
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    const padL = 44;
    const padR = 8;
    const padT = 8;
    const padB = 18;
    const pw = Math.max(10, w - padL - padR);
    const ph = h - padT - padB;
    const series = (opts.series || []).filter((s) => !this.hidden.has(s.key));
    const n = this.times.length;
    // y scale
    let top = opts.max ?? 0;
    if (opts.max === undefined || opts.max === null) {
      let m = 0;
      if (opts.stacked) {
        for (let i = 0; i < n; i++) {
          let sum = 0;
          for (const s of series) { const v = this.data[s.key]?.[i]; if (fin(v)) sum += v; }
          m = Math.max(m, sum);
        }
      } else {
        for (const s of series) for (const v of this.data[s.key] || []) if (fin(v) && v > m) m = v;
      }
      top = niceMax(Math.max(m * 1.1, opts.floor || 0));
    }
    const bottom = opts.min || 0;
    const y = (v) => padT + ph - ((v - bottom) / (top - bottom || 1)) * ph;
    const x = (i) => padL + (n <= 1 ? pw : (i / (n - 1)) * pw);
    // grid
    ctx.font = '10px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';
    ctx.fillStyle = C.axis;
    ctx.strokeStyle = C.grid;
    ctx.lineWidth = 1;
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    for (let g = 0; g <= 4; g++) {
      const v = bottom + ((top - bottom) * g) / 4;
      const yy = Math.round(y(v)) + 0.5;
      ctx.beginPath();
      ctx.moveTo(padL, yy);
      ctx.lineTo(padL + pw, yy);
      ctx.stroke();
      if (g % 2 === 0) ctx.fillText(opts.format(v, true), padL - 6, yy);
    }
    // time labels
    if (n > 1) {
      ctx.textAlign = 'left';
      ctx.textBaseline = 'alphabetic';
      const tf = opts.timeFormat || ((t) => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }));
      ctx.fillText(tf(this.times[0]), padL, h - 4);
      ctx.textAlign = 'right';
      ctx.fillText(tf(this.times[n - 1]), padL + pw, h - 4);
    }
    if (n < 2 || !series.length) {
      ctx.textAlign = 'center';
      ctx.fillStyle = C.axis;
      ctx.fillText(n < 2 ? 'collecting samples…' : 'all series hidden', padL + pw / 2, padT + ph / 2);
      return;
    }
    // series
    const base = new Array(n).fill(0);
    for (const s of series) {
      const vals = this.data[s.key] || [];
      const pts = [];
      for (let i = 0; i < n; i++) {
        const v = vals[i];
        if (!fin(v)) { pts.push(null); continue; }
        const lo = opts.stacked ? base[i] : bottom;
        const hi = opts.stacked ? base[i] + v : v;
        if (opts.stacked) base[i] = hi;
        pts.push([x(i), y(Math.min(top, hi)), y(Math.max(bottom, lo))]);
      }
      // segments split at gaps
      const segs = [];
      let cur = [];
      for (const p of pts) {
        if (!p) { if (cur.length) segs.push(cur); cur = []; } else cur.push(p);
      }
      if (cur.length) segs.push(cur);
      for (const seg of segs) {
        if (s.fill !== false) {
          const grad = ctx.createLinearGradient(0, padT, 0, padT + ph);
          grad.addColorStop(0, `${s.color}55`);
          grad.addColorStop(1, `${s.color}05`);
          ctx.fillStyle = grad;
          ctx.beginPath();
          seg.forEach(([xx, yy], i) => (i ? ctx.lineTo(xx, yy) : ctx.moveTo(xx, yy)));
          for (let i = seg.length - 1; i >= 0; i--) ctx.lineTo(seg[i][0], seg[i][2]);
          ctx.closePath();
          ctx.fill();
        }
        ctx.strokeStyle = s.color;
        ctx.lineWidth = s.width || 1.6;
        ctx.setLineDash(s.dash || []);
        ctx.beginPath();
        seg.forEach(([xx, yy], i) => (i ? ctx.lineTo(xx, yy) : ctx.moveTo(xx, yy)));
        if (seg.length === 1) ctx.arc(seg[0][0], seg[0][1], 1.5, 0, Math.PI * 2);
        ctx.stroke();
        ctx.setLineDash([]);
      }
    }
    // hover
    if (this.hover && this.hover.x >= padL - 4) {
      const i = Math.max(0, Math.min(n - 1, Math.round(((this.hover.x - padL) / pw) * (n - 1))));
      const xx = Math.round(x(i)) + 0.5;
      ctx.strokeStyle = 'rgba(230,230,255,0.45)';
      ctx.setLineDash([3, 3]);
      ctx.beginPath();
      ctx.moveTo(xx, padT);
      ctx.lineTo(xx, padT + ph);
      ctx.stroke();
      ctx.setLineDash([]);
      let acc = 0;
      for (const s of series) {
        const v = this.data[s.key]?.[i];
        if (!fin(v)) continue;
        acc = opts.stacked ? acc + v : v;
        ctx.fillStyle = s.color;
        ctx.beginPath();
        ctx.arc(xx, y(Math.min(top, acc)), 3, 0, Math.PI * 2);
        ctx.fill();
      }
      const t = this.times[i];
      const rows = series.map((s) => {
        const v = this.data[s.key]?.[i];
        return `<div><i style="background:${s.color}"></i><span>${esc(s.label)}</span><b>${fin(v) ? esc(opts.format(v)) : '—'}</b></div>`;
      }).join('');
      this.tip.innerHTML = `<div class="tc-time">${esc(new Date(t).toLocaleTimeString())}</div>${rows}`;
      this.tip.hidden = false;
      const tw = this.tip.offsetWidth;
      const left = xx + 12 + tw > w ? xx - 12 - tw : xx + 12;
      this.tip.style.left = `${Math.max(0, left)}px`;
      this.tip.style.top = '6px';
    }
  }
}

/** A row of tiny per-core bars as HTML (fast to redraw). */
export function coreBars(perCore) {
  return `<div class="cores" style="--n:${Math.min(perCore.length, 32)}">${perCore.map((v, i) => `<i title="core ${i}: ${Math.round(v)}%" style="--v:${Math.max(2, Math.min(100, v))}%;--h:${Math.round(260 - Math.min(100, v) * 2.4)}"></i>`).join('')}</div>`;
}

/**
 * A heat strip (one row per core, one column per sample) on a canvas.
 * rows: array of arrays of 0..100.
 */
export class HeatStrip {
  constructor(host, { height = 70 } = {}) {
    this.host = host;
    this.height = height;
    host.classList.add('heat');
    host.innerHTML = '<canvas></canvas><div class="tc-tip" hidden></div>';
    this.canvas = host.querySelector('canvas');
    this.tip = host.querySelector('.tc-tip');
    this.rows = [];
    this.times = [];
    this.ro = new ResizeObserver(() => this.draw());
    this.ro.observe(host);
    this.canvas.addEventListener('pointermove', (e) => {
      const r = this.canvas.getBoundingClientRect();
      this.hover = { x: e.clientX - r.left, y: e.clientY - r.top };
      this.draw();
    });
    this.canvas.addEventListener('pointerleave', () => { this.hover = null; this.tip.hidden = true; });
  }

  set(times, rows) {
    this.times = times;
    this.rows = rows;
    this.draw();
  }

  destroy() { this.ro.disconnect(); }

  draw() {
    const w = this.host.clientWidth;
    if (!w) return;
    const h = this.height;
    const dpr = window.devicePixelRatio || 1;
    const c = this.canvas;
    if (c.width !== Math.round(w * dpr) || c.height !== Math.round(h * dpr)) {
      c.width = Math.round(w * dpr);
      c.height = Math.round(h * dpr);
      c.style.width = `${w}px`;
      c.style.height = `${h}px`;
    }
    const ctx = c.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    const R = this.rows.length;
    const N = this.times.length;
    if (!R || !N) return;
    const cw = w / N;
    const rh = h / R;
    for (let r = 0; r < R; r++) {
      for (let i = 0; i < N; i++) {
        const v = this.rows[r][i];
        if (!fin(v)) continue;
        const t = Math.max(0, Math.min(1, v / 100));
        // violet (cool) → cyan → amber → red (hot)
        const hue = 280 - t * 260;
        ctx.fillStyle = `hsla(${hue}, 85%, ${28 + t * 32}%, ${0.25 + t * 0.75})`;
        ctx.fillRect(i * cw, r * rh, Math.ceil(cw) + 0.5, Math.max(1, rh - 1));
      }
    }
    if (this.hover) {
      const i = Math.min(N - 1, Math.max(0, Math.floor(this.hover.x / cw)));
      const r = Math.min(R - 1, Math.max(0, Math.floor(this.hover.y / rh)));
      const v = this.rows[r][i];
      ctx.strokeStyle = 'rgba(255,255,255,0.8)';
      ctx.strokeRect(i * cw + 0.5, r * rh + 0.5, Math.max(2, cw - 1), Math.max(2, rh - 2));
      this.tip.innerHTML = `<div class="tc-time">${esc(new Date(this.times[i]).toLocaleTimeString())}</div><div><span>core ${r}</span><b>${fin(v) ? `${Math.round(v)}%` : '—'}</b></div>`;
      this.tip.hidden = false;
      const left = this.hover.x + 14 + this.tip.offsetWidth > w ? this.hover.x - 14 - this.tip.offsetWidth : this.hover.x + 14;
      this.tip.style.left = `${Math.max(0, left)}px`;
      this.tip.style.top = '4px';
    }
  }
}

/** A tiny inline SVG sparkline string. */
export function spark(values, color = C.violet, w = 120, h = 26, max = null) {
  const v = values.filter(fin);
  if (v.length < 2) return `<svg class="spark" viewBox="0 0 ${w} ${h}" aria-hidden="true"></svg>`;
  const top = max ?? Math.max(...v, 1) * 1.1;
  const pts = values.map((x, i) => (fin(x) ? `${((i / (values.length - 1)) * w).toFixed(1)},${(h - 2 - (x / top) * (h - 4)).toFixed(1)}` : null)).filter(Boolean).join(' ');
  return `<svg class="spark" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" aria-hidden="true"><polyline points="${pts}" fill="none" stroke="${color}" stroke-width="1.5" vector-effect="non-scaling-stroke"/></svg>`;
}
