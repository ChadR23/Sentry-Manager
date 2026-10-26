// Aurora: the night sky. Northern-light curtains drawn on one low-resolution
// <canvas> (they are soft, so a half-size canvas stretched by the browser costs
// a quarter of the pixels and looks the same), a still starfield on a second
// canvas drawn only on resize, a few twinkling stars and an occasional shooting
// star animated with opacity/transform only.
//
// Cheap by design: at most 30 frames per second (calm: 20), devicePixelRatio
// capped at 1.5, nothing drawn while the tab is hidden or a video plays, and a
// single still frame for "off" and prefers-reduced-motion.

const TAU = Math.PI * 2;
const COLORS = {
  green: [70, 240, 168],
  teal: [47, 214, 216],
  violet: [155, 125, 255],
  magenta: [232, 110, 224]
};
// [color, top tint, base height (0 = top), amplitude, wave 1, wave 2, speed, curtain height, brightness, depth]
const RIBBONS = [
  ['teal', 'violet', 0.30, 0.07, 1.7, 4.1, 0.050, 0.34, 0.66, 0.6],
  ['green', 'violet', 0.42, 0.09, 1.2, 3.3, 0.070, 0.44, 1.00, 1.0],
  ['violet', 'magenta', 0.22, 0.06, 2.2, 5.0, 0.040, 0.26, 0.62, 0.4],
  ['green', 'teal', 0.56, 0.07, 1.5, 3.8, 0.085, 0.30, 0.58, 1.3],
  ['magenta', 'violet', 0.17, 0.05, 2.7, 6.2, 0.030, 0.20, 0.42, 0.3]
];

function sprite(bottom, top) {
  // one vertical strip: the bright lower edge of a curtain, fading up into a tint
  const c = document.createElement('canvas');
  c.width = 1;
  c.height = 256;
  const g = c.getContext('2d');
  const grad = g.createLinearGradient(0, 0, 0, 256);
  const [r, gg, b] = COLORS[bottom];
  const [tr, tg, tb] = COLORS[top];
  grad.addColorStop(0, `rgba(${tr},${tg},${tb},0)`);
  grad.addColorStop(0.35, `rgba(${tr},${tg},${tb},0.16)`);
  grad.addColorStop(0.72, `rgba(${r},${gg},${b},0.42)`);
  grad.addColorStop(0.9, `rgba(${Math.min(255, r + 60)},${Math.min(255, gg + 15)},${Math.min(255, b + 40)},0.95)`);
  grad.addColorStop(0.95, `rgba(${r},${gg},${b},0.35)`);
  grad.addColorStop(1, `rgba(${r},${gg},${b},0)`);
  g.fillStyle = grad;
  g.fillRect(0, 0, 1, 256);
  return c;
}

export function createSky({ canvas, stars, shoot, twinkleHost = document.body }) {
  const ctx = canvas.getContext('2d', { alpha: true });
  const sctx = stars.getContext('2d', { alpha: true });
  const strips = RIBBONS.map(([a, b]) => sprite(a, b));
  const reduce = matchMedia('(prefers-reduced-motion: reduce)');
  const holds = new Set();
  let mode = document.documentElement.dataset.effect || 'calm';
  let raf = 0;
  let last = 0;
  let t = 37; // a pretty moment for the still frame
  let W = 0;
  let H = 0;
  let scale = 0.5;
  const ptr = { x: 0, y: 0, tx: 0, ty: 0 };
  let frames = 0;
  let shootTimer = 0;
  let twinkles = [];

  const animated = () => mode !== 'off' && !reduce.matches;
  const running = () => animated() && !holds.size && !document.hidden;

  function size() {
    const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
    const cw = Math.max(1, innerWidth);
    const ch = Math.max(1, innerHeight);
    scale = mode === 'calm' ? 0.2 : 0.28;
    W = Math.max(64, Math.round(cw * scale));
    H = Math.max(64, Math.round(ch * scale));
    canvas.width = W;
    canvas.height = H;
    stars.width = Math.round(cw * dpr);
    stars.height = Math.round(ch * dpr);
    drawStars(dpr, cw, ch);
    placeTwinkles(cw, ch);
    draw(0);
  }

  // a seeded random so the stars stay where they were on resize
  function rng(seed) {
    let s = seed >>> 0;
    return () => {
      s = (s + 0x6D2B79F5) >>> 0;
      let x = Math.imul(s ^ (s >>> 15), 1 | s);
      x ^= x + Math.imul(x ^ (x >>> 7), 61 | x);
      return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
    };
  }

  function drawStars(dpr, cw, ch) {
    sctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    sctx.clearRect(0, 0, cw, ch);
    const rand = rng(1977);
    const n = Math.round((cw * ch) / 2300);
    for (let i = 0; i < n; i++) {
      const x = rand() * cw;
      // fewer stars near the horizon glow
      const y = Math.pow(rand(), 1.35) * ch;
      const m = rand();
      const r = m > 0.985 ? 1.5 : m > 0.92 ? 1.05 : 0.65;
      const a = (0.35 + rand() * 0.6) * (1 - (y / ch) * 0.55);
      const tint = rand();
      sctx.fillStyle = tint > 0.8 ? `rgba(200,220,255,${a})` : tint > 0.65 ? `rgba(255,240,220,${a})` : `rgba(255,255,255,${a})`;
      sctx.beginPath();
      sctx.arc(x, y, r, 0, TAU);
      sctx.fill();
      if (r > 1.4) {
        const g = sctx.createRadialGradient(x, y, 0, x, y, 6);
        g.addColorStop(0, `rgba(210,230,255,${a * 0.35})`);
        g.addColorStop(1, 'rgba(210,230,255,0)');
        sctx.fillStyle = g;
        sctx.fillRect(x - 6, y - 6, 12, 12);
      }
    }
  }

  function placeTwinkles(cw, ch) {
    for (const el of twinkles) el.remove();
    twinkles = [];
    const rand = rng(4242);
    const n = cw < 600 ? 10 : 22;
    for (let i = 0; i < n; i++) {
      const el = document.createElement('span');
      el.className = 'twinkle';
      el.setAttribute('aria-hidden', 'true');
      el.style.left = `${(rand() * cw).toFixed(1)}px`;
      el.style.top = `${(Math.pow(rand(), 1.4) * ch * 0.85).toFixed(1)}px`;
      el.style.animationDelay = `${(-rand() * 7).toFixed(2)}s`;
      el.style.animationDuration = `${(3.5 + rand() * 5).toFixed(2)}s`;
      if (rand() > 0.6) el.classList.add('big');
      twinkleHost.append(el);
      twinkles.push(el);
    }
  }

  function draw(dt) {
    t += dt;
    // ease the parallax towards the pointer / tilt
    ptr.x += (ptr.tx - ptr.x) * Math.min(1, dt * 1.6 + (dt ? 0 : 1));
    ptr.y += (ptr.ty - ptr.y) * Math.min(1, dt * 1.6 + (dt ? 0 : 1));
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalCompositeOperation = 'source-over';
    ctx.clearRect(0, 0, W, H);
    ctx.globalCompositeOperation = 'lighter';
    const calm = mode === 'calm';
    const step = calm ? 3 : 2;
    const list = calm ? RIBBONS.slice(0, 3) : RIBBONS;
    const narrow = W < 260;
    for (let k = 0; k < list.length; k++) {
      const [, , base, amp, f1, f2, speed, height, bright, depth] = list[k];
      const strip = strips[k];
      const hh = H * height * (narrow ? 1.15 : 1);
      const px = ptr.x * 22 * depth * scale * 2;
      const py = ptr.y * 14 * depth * scale * 2;
      const tt = t * speed * (calm ? 0.7 : 1);
      const slow = Math.sin(t * 0.05 + k) * 0.5 + 0.5;
      for (let x = -step; x < W + step; x += step) {
        const u = (x - px) / W;
        const y = H * (base + amp * (0.62 * Math.sin(u * f1 * TAU * 0.5 + tt * 3 + k * 1.7)
          + 0.38 * Math.sin(u * f2 * TAU * 0.5 - tt * 4.3 + k)))
          + H * 0.02 * Math.sin(u * 23 + tt * 9) + py;
        // vertical rays: brightness rippling along the curtain
        const ray = 0.5 + 0.5 * Math.sin(u * 61 + tt * 13 + k * 3) * Math.sin(u * 17 - tt * 5);
        const fold = 0.55 + 0.45 * Math.sin(u * 7.3 + tt * 2.1 + k);
        // fade out towards the left and right edges, and breathe slowly
        const edge = Math.min(1, Math.sin(Math.max(0, Math.min(1, u)) * Math.PI) * 1.6 + 0.12);
        const a = bright * edge * (0.35 + 0.65 * ray * fold) * (0.75 + 0.25 * slow);
        if (a < 0.02) continue;
        ctx.globalAlpha = Math.min(1, a);
        ctx.drawImage(strip, 0, 0, 1, 256, x, y - hh * 0.9, step + 1, hh);
      }
    }
    ctx.globalAlpha = 1;
    frames += 1;
  }

  function loop() {
    raf = 0;
    if (!running()) return;
    // capped by the wall clock (a rAF timestamp can lag behind under load)
    const now = performance.now();
    const gap = 1000 / (mode === 'calm' ? 20 : 30);
    if (!last) last = now - gap;
    const dt = now - last;
    if (dt >= gap - 1) {
      last = now;
      draw(Math.min(dt, 100) / 1000);
    }
    raf = requestAnimationFrame(loop);
  }

  function shootingStar() {
    clearTimeout(shootTimer);
    if (mode !== 'full' || reduce.matches) return;
    shootTimer = setTimeout(() => {
      if (running() && shoot && shoot.animate) {
        const sx = innerWidth * (0.15 + Math.random() * 0.6);
        const sy = innerHeight * (0.05 + Math.random() * 0.25);
        const len = Math.min(420, innerWidth * 0.4);
        shoot.style.left = `${sx}px`;
        shoot.style.top = `${sy}px`;
        shoot.animate([
          { transform: 'rotate(-28deg) translateX(0) scaleX(.3)', opacity: 0 },
          { transform: `rotate(-28deg) translateX(${len * 0.3}px) scaleX(1)`, opacity: 1, offset: 0.25 },
          { transform: `rotate(-28deg) translateX(${len}px) scaleX(.6)`, opacity: 0 }
        ], { duration: 1100, easing: 'ease-out' });
      }
      shootingStar();
    }, 16000 + Math.random() * 26000);
  }

  function update() {
    document.documentElement.classList.toggle('sky-still', !running());
    if (running()) {
      if (!raf) {
        last = 0;
        raf = requestAnimationFrame(loop);
      }
    } else if (raf) {
      cancelAnimationFrame(raf);
      raf = 0;
    }
  }

  // ---------- inputs ----------
  addEventListener('pointermove', (e) => {
    if (e.pointerType !== 'mouse') return;
    ptr.tx = (e.clientX / innerWidth) * 2 - 1;
    ptr.ty = (e.clientY / innerHeight) * 2 - 1;
  }, { passive: true });
  addEventListener('deviceorientation', (e) => {
    if (e.gamma === null || e.beta === null) return;
    ptr.tx = Math.max(-1, Math.min(1, e.gamma / 35));
    ptr.ty = Math.max(-1, Math.min(1, (e.beta - 45) / 45));
  }, { passive: true });
  let resizeTimer = 0;
  addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(size, 150);
  });
  document.addEventListener('visibilitychange', update);
  reduce.addEventListener?.('change', () => { size(); update(); });

  size();
  update();
  shootingStar();

  return {
    /** full | calm | off */
    setMode(next) {
      mode = next;
      document.documentElement.dataset.effect = next;
      size();
      update();
      shootingStar();
    },
    get mode() { return mode; },
    /** Pause while `reason` holds (a playing video), resume when released. */
    hold(reason, on) {
      if (on) holds.add(reason);
      else holds.delete(reason);
      update();
    },
    get frames() { return frames; },
    get running() { return running(); }
  };
}
