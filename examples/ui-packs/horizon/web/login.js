'use strict';
// Horizon: the background engine (dusk sky, striped sun, wireframe mountains and
// an endless neon grid floor) and the sign-in page. The sign-in page may only load
// this file and shell.css, so the app loads this same file for its background;
// the sign-in part only runs on the sign-in page.
//
// Cost: the sky, sun, mountains, haze, scanlines and grain are static layers (CSS
// and one inline SVG, the haze and sun glow only fade with opacity). The moving
// floor is ONE canvas covering only the area below the horizon, drawn at most
// 30 times a second (12 in "calm"), with devicePixelRatio capped at 1.5. It stops
// completely while the tab is hidden or a video plays in the Viewer.

(() => {
  const root = document.documentElement;
  const reduce = matchMedia('(prefers-reduced-motion: reduce)');
  const KEY = 'horizon.sky';
  const readMode = () => {
    try {
      const m = JSON.parse(localStorage.getItem(KEY) || 'null');
      if (m === 'full' || m === 'calm' || m === 'off') return m;
    } catch { /* private window */ }
    return 'auto';
  };

  const sky = {
    choice: readMode(), // what the viewer picked: auto | full | calm | off
    mode: 'full', // what runs: full | calm | still | off
    holds: new Set(),
    boost: 0, // 0..1, eased toward engineTarget
    engineTarget: 0,
    canvas: null,
    ctx: null,
    w: 0,
    h: 0,
    dpr: 1,
    phase: 0,
    raf: 0,
    last: 0,
    lastDraw: 0,
    frames: 0
  };

  function effective() {
    if (sky.choice === 'off') return 'off';
    if (reduce.matches) return 'still';
    if (sky.choice === 'calm') return 'calm';
    if (sky.choice === 'full') return 'full';
    // auto: phones get "calm", everything else "full"
    const phone = matchMedia('(pointer: coarse)').matches && Math.min(screen.width, screen.height) < 600;
    return phone ? 'calm' : 'full';
  }

  // ---------- static layers ----------
  function rng(seed) {
    let s = seed >>> 0;
    return () => {
      s = (s * 1664525 + 1013904223) >>> 0;
      return s / 4294967296;
    };
  }
  /** Wireframe mountain ranges on both sides of the sun, as one SVG. */
  function mountains() {
    const W = 1600;
    const H = 220;
    const r = rng(20261026);
    const range = (x0, x1, peak) => {
      const pts = [[x0, H]];
      const n = 9;
      for (let i = 1; i < n; i++) {
        const x = x0 + ((x1 - x0) * i) / n + (r() - 0.5) * 30;
        const mid = 1 - Math.abs(i / n - 0.5) * 1.7;
        const y = H - (peak * (0.35 + 0.65 * mid) * (0.55 + r() * 0.45));
        pts.push([x, y]);
      }
      pts.push([x1, H]);
      return pts;
    };
    const left = range(-40, 640, 200);
    const right = range(960, 1640, 170);
    const back = range(380, 1220, 90);
    const poly = (pts) => pts.map(([x, y]) => `${x.toFixed(0)},${y.toFixed(0)}`).join(' ');
    const facets = (pts) => {
      let d = '';
      for (let i = 1; i < pts.length - 1; i++) {
        const [x, y] = pts[i];
        d += `M${x.toFixed(0)} ${y.toFixed(0)}L${(x + (r() - 0.5) * 60).toFixed(0)} ${H}`;
        if (i < pts.length - 2) {
          const [nx, ny] = pts[i + 1];
          const mx = (x + nx) / 2;
          const my = Math.max(y, ny) + (H - Math.max(y, ny)) * 0.45;
          d += `M${x.toFixed(0)} ${y.toFixed(0)}L${mx.toFixed(0)} ${my.toFixed(0)}L${nx.toFixed(0)} ${ny.toFixed(0)}`;
        }
      }
      return d;
    };
    const one = (pts, cls) => `<polygon class="m-fill ${cls}" points="${poly(pts)}"/><path class="m-wire ${cls}" d="${facets(pts)}"/><polyline class="m-ridge ${cls}" points="${poly(pts)}"/>`;
    return `<svg class="sky-mtn" viewBox="0 0 1600 ${H}" preserveAspectRatio="xMidYMax slice" aria-hidden="true" focusable="false">${one(back, 'far')}${one(left, 'near')}${one(right, 'near')}</svg>`;
  }

  function build() {
    let el = document.getElementById('sky');
    if (!el) {
      el = document.createElement('div');
      el.id = 'sky';
      document.body.prepend(el);
    }
    el.className = 'sky';
    el.setAttribute('aria-hidden', 'true');
    el.innerHTML = `<div class="sky-stars"></div><div class="sky-glow"></div><div class="sky-sun"></div>${mountains()}<div class="sky-haze"></div><div class="sky-floor"><canvas class="sky-grid"></canvas></div><div class="sky-fx"></div>`;
    sky.canvas = el.querySelector('canvas');
    sky.ctx = sky.canvas.getContext('2d', { alpha: true });
  }

  // ---------- the grid floor ----------
  function size() {
    const c = sky.canvas;
    if (!c) return;
    const r = c.getBoundingClientRect();
    sky.dpr = Math.min(1.5, window.devicePixelRatio || 1);
    const w = Math.max(1, Math.round(r.width * sky.dpr));
    const hgt = Math.max(1, Math.round(r.height * sky.dpr));
    if (w !== c.width || hgt !== c.height) {
      c.width = w;
      c.height = hgt;
    }
    sky.w = w;
    sky.h = hgt;
    draw();
  }

  function draw() {
    const { ctx, w, h } = sky;
    if (!ctx || !w || !h) return;
    ctx.clearRect(0, 0, w, h);
    if (sky.mode === 'off') return;
    const cx = w / 2;
    const unit = Math.max(w, h * 2.2) / 9; // floor spacing at the near edge
    ctx.beginPath();
    // the rows: y = h / z, z running from 1 (bottom edge) to the horizon
    const ph = sky.phase % 1;
    for (let k = 1; k < 60; k++) {
      const z = k - ph;
      if (z < 0.98) continue;
      const y = h / z;
      if (y < 1.5) break;
      ctx.moveTo(0, y);
      ctx.lineTo(w, y);
    }
    // the columns, converging on the vanishing point
    const cols = Math.ceil((w / 2) / unit) + 8;
    for (let i = -cols; i <= cols; i++) {
      const xb = cx + i * unit * 1.6;
      ctx.moveTo(cx + (xb - cx) * 0.02, 0);
      ctx.lineTo(xb, h);
    }
    // one solid stroke; the fade into the horizon and the glow are static CSS layers
    ctx.strokeStyle = '#ff62cc';
    ctx.lineWidth = 1.5 * sky.dpr;
    ctx.stroke();
  }

  function frame(t) {
    sky.raf = 0;
    if (!running()) return;
    const fps = sky.mode === 'calm' ? 12 : 30;
    const dt = sky.last ? Math.min(0.1, (t - sky.last) / 1000) : 0;
    if (t - sky.lastDraw >= 1000 / fps - 2) {
      sky.last = t;
      sky.lastDraw = t;
      sky.boost += (sky.engineTarget - sky.boost) * Math.min(1, dt * 1.2);
      const base = sky.mode === 'calm' ? 0.18 : 0.55;
      sky.phase += dt * base * (1 + sky.boost * 1.6);
      sky.frames++;
      draw();
    }
    sky.raf = requestAnimationFrame(frame);
  }
  const running = () => (sky.mode === 'full' || sky.mode === 'calm') && !document.hidden && sky.holds.size === 0;
  function kick() {
    if (running()) {
      if (!sky.raf) {
        sky.last = 0;
        sky.raf = requestAnimationFrame(frame);
      }
    } else if (sky.raf) {
      cancelAnimationFrame(sky.raf);
      sky.raf = 0;
    }
    root.classList.toggle('sky-moving', running());
  }

  function apply() {
    sky.mode = effective();
    root.dataset.sky = sky.mode;
    size();
    kick();
  }

  // public handle for the app
  window.HorizonSky = {
    get choice() { return sky.choice; },
    get mode() { return sky.mode; },
    get frames() { return sky.frames; },
    setChoice(m) {
      sky.choice = ['full', 'calm', 'off'].includes(m) ? m : 'auto';
      try {
        if (sky.choice === 'auto') localStorage.removeItem(KEY); else localStorage.setItem(KEY, JSON.stringify(sky.choice));
      } catch { /* private window */ }
      apply();
    },
    /** Stops the animation while `reason` holds (e.g. a video playing). */
    hold(reason, on) {
      if (on) sky.holds.add(reason); else sky.holds.delete(reason);
      kick();
    },
    /** The "engine running" cue: the floor speeds up while a conversion runs. */
    engine(on) {
      sky.engineTarget = on ? 1 : 0;
      root.classList.toggle('engine-on', Boolean(on));
    }
  };

  function start() {
    build();
    apply();
    let t = 0;
    window.addEventListener('resize', () => {
      clearTimeout(t);
      t = setTimeout(size, 120);
    });
    document.addEventListener('visibilitychange', kick);
    reduce.addEventListener?.('change', apply);
  }
  if (document.body) start(); else document.addEventListener('DOMContentLoaded', start);
})();

// ---------- sign-in ----------
(async () => {
  if (document.body?.dataset.page !== 'login') return;
  const $ = (id) => document.getElementById(id);
  // continue only to a page of this server
  const next = (() => {
    const raw = new URLSearchParams(location.search).get('next') || '/';
    if (!raw.startsWith('/') || raw.startsWith('//') || /[\\\s]/.test(raw)) return '/';
    try {
      const u = new URL(raw, location.origin);
      return u.origin === location.origin ? u.pathname + u.search + u.hash : '/';
    } catch {
      return '/';
    }
  })();
  const me = await fetch('/api/auth/me', { credentials: 'same-origin' }).then((r) => r.json()).catch(() => ({}));
  if (me.user) {
    location.replace(next);
    return;
  }
  $('host').textContent = location.host;
  if (location.protocol !== 'https:') $('insecure').hidden = false;
  if (me.fingerprint) {
    const box = $('fp-val');
    box.replaceChildren(...String(me.fingerprint).split(':').flatMap((part, i) => (i ? [':', document.createElement('wbr'), part] : [part])));
    $('fp').hidden = false;
  }
  const setup = Boolean(me.needsSetup);
  const form = $('form');
  if (setup) {
    $('title').textContent = 'Create your account';
    $('lead').textContent = 'First start. Type the setup code from the container log, then choose the user name and password that will protect this server.';
    $('confirm-row').hidden = false;
    $('code-row').hidden = false;
    $('go').textContent = 'Create account';
    form.password.autocomplete = 'new-password';
  }
  let lock = 0;
  function wait(seconds, text) {
    clearInterval(lock);
    let left = seconds;
    $('go').disabled = true;
    const tick = () => {
      $('err').textContent = `${text.replace(/Try again in \d+ ?s(econds)?\.?/i, '').trim()} Try again in ${left} s.`;
      if (left-- <= 0) {
        clearInterval(lock);
        $('go').disabled = false;
        $('err').textContent = '';
      }
    };
    tick();
    lock = setInterval(tick, 1000);
  }
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = new FormData(form);
    $('err').textContent = '';
    if (!f.get('username') || !f.get('password')) {
      $('err').textContent = 'Type your user name and password.';
      return;
    }
    if (setup) {
      if (String(f.get('password')).length < 8) { $('err').textContent = 'Choose a password of at least 8 characters.'; return; }
      if (f.get('password') !== f.get('confirm')) { $('err').textContent = 'The two passwords are not the same.'; return; }
      if (!f.get('code')) { $('err').textContent = 'Type the setup code from the container log.'; return; }
    }
    $('go').disabled = true;
    document.body.classList.add('igniting');
    const res = await fetch(setup ? '/api/auth/setup' : '/api/auth/login', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'sentry-six-manager' },
      body: JSON.stringify({ username: f.get('username'), password: f.get('password'), ...(setup ? { code: f.get('code') } : {}) })
    }).catch(() => null);
    $('go').disabled = false;
    if (res && res.ok) {
      window.HorizonSky?.engine(true);
      location.replace(next);
      return;
    }
    document.body.classList.remove('igniting');
    const data = res ? await res.json().catch(() => ({})) : {};
    const msg = data.error || (res ? `Sign-in failed (${res.status}).` : 'Sentry Six Manager cannot be reached.');
    if (res && res.status === 429) {
      const m = /(\d+)\s*s/.exec(msg);
      wait(m ? Number(m[1]) : 30, msg);
      return;
    }
    $('err').textContent = msg;
    form.password.select();
  });
})();
