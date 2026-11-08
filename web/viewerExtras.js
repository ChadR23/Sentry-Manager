// Viewer conveniences, the same in every interface:
//
// - Picture in picture: a button that floats the main camera in its own
//   window, so the footage keeps playing while you use other pages or apps.
// - Resume: where you were (vehicle, clip, second) is remembered in this
//   browser; opening the Viewer later offers to go back there.
// - Zoom a still: while paused, scrolling (mouse) or pinching (touch) over a
//   camera zooms into it at that spot, up to 6x, and dragging moves around
//   (to read a number plate). Playing, or a double-click, resets it.
// - Frame by frame on phones: while paused, large ‹ › buttons step one
//   frame back or forward.
//
//   const extras = attachViewerExtras({
//     stage,                       // the element holding the cameras
//     videos: () => [video, …],    // the camera videos shown now
//     main: () => video,           // the large / master one
//     buttons: el,                 // where the picture-in-picture button goes (optional)
//     step: (dir) => …,            // one frame back (-1) or forward (+1), all cameras
//     where: () => ({ vehicle, day, clip, second }) | null,   // for resume
//     resumeTo: (pos) => …,        // go there (a link with at=…)
//     offerResume: true            // false when the page was opened at a given moment
//   });
//   extras.destroy();

import { timeAfter } from '/web/scrub.js';

const CSS = `
.sentry-x-btn{all:unset;box-sizing:border-box;cursor:pointer;display:inline-flex;align-items:center;gap:6px;padding:6px 10px;border-radius:8px;
  border:1px solid rgba(127,127,127,.5);font-weight:600;font-size:13px;line-height:1.2}
.sentry-x-btn:hover{background:rgba(127,127,127,.16)}
.sentry-x-btn:focus-visible{outline:2px solid currentColor;outline-offset:2px}
.sentry-x-btn svg{width:16px;height:16px}
@media (max-width:700px){.sentry-x-btn span{display:none}.sentry-x-btn{padding:6px 8px}}
.sentry-x-steps{position:absolute;left:0;right:0;bottom:12px;z-index:5;display:flex;justify-content:center;gap:28px;pointer-events:none}
.sentry-x-steps.fixed{position:fixed;bottom:calc(96px + env(safe-area-inset-bottom));z-index:2147482000}
.sentry-x-steps button{all:unset;pointer-events:auto;width:58px;height:58px;border-radius:50%;display:grid;place-items:center;cursor:pointer;
  background:rgba(0,0,0,.6);color:#fff;font:700 26px/1 system-ui,sans-serif;border:2px solid rgba(255,255,255,.75);-webkit-tap-highlight-color:transparent}
.sentry-x-steps button:active{background:rgba(0,0,0,.85)}
.sentry-x-resume{position:fixed;left:50%;bottom:calc(18px + env(safe-area-inset-bottom));transform:translateX(-50%);z-index:2147483647;
  display:flex;gap:10px;align-items:center;flex-wrap:wrap;justify-content:center;max-width:calc(100vw - 24px);padding:10px 14px;border-radius:12px;
  background:rgba(20,22,28,.94);color:#fff;font:500 14px/1.35 system-ui,sans-serif;box-shadow:0 8px 28px rgba(0,0,0,.45)}
.sentry-x-resume.top{top:calc(14px + env(safe-area-inset-top));bottom:auto}
.sentry-x-resume button{all:unset;cursor:pointer;font-weight:700;padding:6px 12px;border-radius:8px;border:1px solid rgba(255,255,255,.55)}
.sentry-x-resume button[data-go]{background:#fff;color:#111}
.sentry-x-resume button:focus-visible{outline:2px solid #fff;outline-offset:2px}
.sentry-x-zoomhint{position:absolute;top:8px;left:50%;transform:translateX(-50%);z-index:6;padding:3px 9px;border-radius:6px;background:rgba(0,0,0,.65);color:#fff;
  font:600 12px/1.4 system-ui,sans-serif;pointer-events:none}
`;
const PIP_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><rect x="2" y="4" width="20" height="16" rx="2"/><rect x="12" y="11" width="8" height="6" rx="1" fill="currentColor"/></svg>';
const RESUME_KEY = 'sentry-resume';
const RESUME_DAYS = 14;

function addCss() {
  if (document.getElementById('sentry-x-css')) return;
  const style = document.createElement('style');
  style.id = 'sentry-x-css';
  style.textContent = CSS;
  document.head.appendChild(style);
}
const clockOf = (hms) => { const [h, m, s] = hms.split('-').map(Number); return `${h % 12 || 12}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`; };
const dayOf = (d) => { try { return new Date(`${d}T12:00:00`).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' }); } catch { return d; } };
/** Where this browser last was in a vehicle's footage (in the last 14 days), or null. */
export function savedPosition(vehicle) { return readResume(vehicle); }
function readResume(vehicle) {
  try {
    const all = JSON.parse(localStorage.getItem(RESUME_KEY) || '{}');
    const pos = all[vehicle];
    return pos && Date.now() - pos.savedAt < RESUME_DAYS * 86400000 ? pos : null;
  } catch { return null; }
}
function saveResume(pos) {
  try {
    const all = JSON.parse(localStorage.getItem(RESUME_KEY) || '{}');
    all[pos.vehicle] = { ...pos, savedAt: Date.now() };
    localStorage.setItem(RESUME_KEY, JSON.stringify(all));
  } catch { /* private window: no resume */ }
}

export function attachViewerExtras({ stage, videos: listVideos = () => [], main: mainVideo = () => null, buttons = null, step = null, where: whereNow = null, resumeTo = null, offerResume = true, stepsFixed = false } = {}) {
  addCss();
  // a page may attach this before everything it asks about exists yet
  const videos = () => { try { return (listVideos() || []).filter(Boolean); } catch { return []; } };
  const main = () => { try { return mainVideo() || null; } catch { return null; } };
  const where = whereNow ? () => { try { return whereNow(); } catch { return null; } } : null;
  const cleanups = [];
  const on = (el, type, fn, opts) => { el.addEventListener(type, fn, opts); cleanups.push(() => el.removeEventListener(type, fn, opts)); };

  // ---- picture in picture
  if (buttons && document.pictureInPictureEnabled) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'sentry-x-btn';
    b.title = 'Picture in picture: keep the main camera playing in its own window';
    b.setAttribute('aria-label', 'Picture in picture');
    b.innerHTML = `${PIP_ICON}<span>Pop out</span>`;
    on(b, 'click', async () => {
      try {
        if (document.pictureInPictureElement) await document.exitPictureInPicture();
        else await main()?.requestPictureInPicture();
      } catch { /* not ready or not allowed */ }
    });
    buttons.appendChild(b);
    // a row that cannot fit one more button wraps instead of widening the page
    if (getComputedStyle(buttons).display.includes('flex')) buttons.style.flexWrap = 'wrap';
    cleanups.push(() => b.remove());
  }

  // ---- resume where you left off
  let lastSave = 0;
  const remember = () => {
    const pos = where?.();
    if (!pos?.vehicle || !pos.clip || Date.now() - lastSave < 4000) return;
    lastSave = Date.now();
    saveResume({ ...pos, second: Math.floor(pos.second || 0) });
  };
  const ticker = setInterval(remember, 5000);
  cleanups.push(() => { clearInterval(ticker); lastSave = 0; remember(); });
  if (offerResume && where && resumeTo) {
    // what this page opened on, to tell a saved spot elsewhere from here
    let gone = false; // the page was left before the offer came
    cleanups.push(() => { gone = true; clearTimeout(offer); });
    const offer = setTimeout(() => {
      if (gone) return;
      const here = where();
      const saved = here?.vehicle ? readResume(here.vehicle) : null;
      if (!saved || (saved.clip === here.clip && Math.abs(saved.second - (here.second || 0)) < 10)) return;
      if (saved.second < 5 && saved.clip === here.clip) return;
      const box = document.createElement('div');
      // (at the top where the page's own controls sit at the bottom)
      box.className = `sentry-x-resume${stepsFixed ? ' top' : ''}`;
      box.setAttribute('role', 'status');
      const at = timeAfter(saved.clip, saved.second);
      box.innerHTML = '<span></span><button type="button" data-go>Resume</button><button type="button" data-no>No thanks</button>';
      box.firstChild.textContent = `Pick up where you left off: ${dayOf(saved.day)}, ${at ? clockOf(at) : saved.clip}?`;
      box.addEventListener('click', (e) => {
        if (e.target.closest('[data-go]')) resumeTo(saved);
        if (e.target.closest('[data-go], [data-no]')) box.remove();
      });
      document.body.appendChild(box);
      const hide = setTimeout(() => box.remove(), 15000);
      cleanups.push(() => { clearTimeout(hide); box.remove(); });
    }, 2500);
  }

  // ---- zoom a still (paused): wheel or pinch over a camera, drag to move
  const zoom = new Map(); // video -> { s, x, y }
  const paused = () => videos().every((v) => v.paused);
  // the camera under the pointer, also under its own overlays (a HUD,
  // labels, the tile around it), but not under a panel that floats over it
  // (a clip list that scrolls with the wheel)
  // (by position: a page may give its videos pointer-events: none)
  const videoAt = (e) => {
    if (e.target?.tagName === 'VIDEO') return e.target;
    if (!e.target) return null;
    return videos().find((v) => {
      const r = v.getBoundingClientRect();
      return e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom
        && (v.parentElement?.contains(e.target) || e.target.contains?.(v));
    }) || null;
  };
  // touches while paused: a zoomed camera takes them all (drag the picture);
  // one not zoomed lets the page scroll up and down, and a pinch still zooms
  function touchOf(v) { v.style.touchAction = paused() ? (zoom.has(v) ? 'none' : 'pan-y') : ''; }
  function apply(v) {
    const z = zoom.get(v);
    if (!z || z.s <= 1.01) {
      zoom.delete(v);
      touchOf(v);
      v.style.scale = '';
      v.style.translate = '';
      v.style.transformOrigin = '';
      v.parentElement?.querySelector('.sentry-x-zoomhint')?.remove();
      return;
    }
    touchOf(v);
    v.style.transformOrigin = '0 0';
    v.style.translate = `${z.x}px ${z.y}px`;
    v.style.scale = String(z.s);
    if (v.parentElement && getComputedStyle(v.parentElement).overflow === 'visible') v.parentElement.style.overflow = 'hidden';
    let hint = v.parentElement?.querySelector('.sentry-x-zoomhint');
    if (!hint && v.parentElement) {
      hint = document.createElement('div');
      hint.className = 'sentry-x-zoomhint';
      if (getComputedStyle(v.parentElement).position === 'static') v.parentElement.style.position = 'relative';
      v.parentElement.appendChild(hint);
    }
    if (hint) hint.textContent = `${z.s.toFixed(1)}× · double-click or play to reset`;
  }
  function zoomAt(v, factor, cx, cy) {
    const r = v.getBoundingClientRect();
    const z = zoom.get(v) || { s: 1, x: 0, y: 0 };
    const s = Math.max(1, Math.min(6, z.s * factor));
    // keep the point under the pointer where it is: with the origin at the
    // top left, the box's left edge on screen is its own plus the shift
    const px = cx - (r.left - z.x);
    const py = cy - (r.top - z.y);
    const ux = (px - z.x) / z.s; // that point in the unzoomed picture
    const uy = (py - z.y) / z.s;
    z.x = Math.min(0, Math.max(v.offsetWidth * (1 - s), px - ux * s));
    z.y = Math.min(0, Math.max(v.offsetHeight * (1 - s), py - uy * s));
    z.s = s;
    zoom.set(v, z);
    apply(v);
  }
  const resetAll = () => { for (const v of [...zoom.keys()]) { zoom.delete(v); apply(v); } };
  on(stage, 'wheel', (e) => {
    const v = videoAt(e);
    if (!v || !paused()) return;
    e.preventDefault();
    e.stopPropagation();
    zoomAt(v, e.deltaY < 0 ? 1.15 : 1 / 1.15, e.clientX, e.clientY);
  }, { passive: false, capture: true }); // before the page's own handlers (a tile that drags)
  on(stage, 'dblclick', (e) => { if (zoom.size && videoAt(e)) { e.preventDefault(); e.stopPropagation(); resetAll(); } }, true);
  // drag to move, pinch to zoom
  const pts = new Map();
  let pinch = null;
  let drag = null;
  on(stage, 'pointerdown', (e) => {
    const v = videoAt(e);
    if (!v || !paused()) return;
    pts.set(e.pointerId, { x: e.clientX, y: e.clientY, v });
    if (pts.size === 2) {
      const [a, b] = [...pts.values()];
      pinch = { v: a.v, d: Math.hypot(a.x - b.x, a.y - b.y) };
      drag = null;
    } else if (zoom.has(v)) drag = { v, x: e.clientX, y: e.clientY, moved: false };
  }, true);
  on(stage, 'pointermove', (e) => {
    if (!pts.has(e.pointerId)) return;
    pts.get(e.pointerId).x = e.clientX;
    pts.get(e.pointerId).y = e.clientY;
    if (pinch && pts.size === 2) {
      const [a, b] = [...pts.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      if (pinch.d > 0) zoomAt(pinch.v, d / pinch.d, (a.x + b.x) / 2, (a.y + b.y) / 2);
      pinch.d = d;
      e.preventDefault();
    } else if (drag) {
      const z = zoom.get(drag.v);
      if (!z) return;
      z.x = Math.min(0, Math.max(drag.v.offsetWidth * (1 - z.s), z.x + e.clientX - drag.x));
      z.y = Math.min(0, Math.max(drag.v.offsetHeight * (1 - z.s), z.y + e.clientY - drag.y));
      drag.moved = drag.moved || Math.abs(e.clientX - drag.x) + Math.abs(e.clientY - drag.y) > 3;
      drag.x = e.clientX;
      drag.y = e.clientY;
      apply(drag.v);
    }
  }, true);
  const up = (e) => {
    pts.delete(e.pointerId);
    if (pts.size < 2) pinch = null;
    if (!pts.size) drag = null;
  };
  on(stage, 'pointerup', up, true);
  on(stage, 'pointercancel', up, true);
  // a click that only moved the zoomed picture does not also act (swap cameras)
  on(stage, 'click', (e) => { if (drag?.moved) { e.stopPropagation(); e.preventDefault(); } }, true);
  // a zoomed camera takes touches itself (no page zoom or scroll) while paused
  const touchMode = () => { for (const v of videos()) touchOf(v); };

  // ---- frame by frame on phones (paused)
  let steps = null;
  const coarse = window.matchMedia('(pointer: coarse)');
  function drawSteps() {
    const m = main();
    const want = step && coarse.matches && m && paused() && !m.hidden;
    if (!want) { steps?.remove(); steps = null; return; }
    // (fixed: above everything, for a page whose panels float over the cameras)
    const host = stepsFixed ? document.body : m.parentElement;
    if (!host) return;
    if (!steps) {
      steps = document.createElement('div');
      steps.className = `sentry-x-steps${stepsFixed ? ' fixed' : ''}`;
      steps.innerHTML = '<button type="button" data-step="-1" aria-label="One frame back">‹</button><button type="button" data-step="1" aria-label="One frame forward">›</button>';
      steps.addEventListener('click', (e) => {
        const b = e.target.closest('[data-step]');
        if (b) { e.stopPropagation(); step(Number(b.dataset.step)); }
      });
    }
    if (steps.parentElement !== host) {
      if (!stepsFixed && getComputedStyle(host).position === 'static') host.style.position = 'relative';
      host.appendChild(steps);
    }
  }
  cleanups.push(() => steps?.remove());

  // playing again: zoom off; paused: steps and touch handling on
  const sync = (e) => {
    if (e?.type === 'play' || e?.type === 'playing') resetAll();
    drawSteps();
    touchMode();
  };
  for (const type of ['play', 'playing', 'pause', 'loadeddata', 'emptied']) on(stage, type, sync, true);
  setTimeout(sync, 0);

  // ---- the car's data at this moment, in blocks you choose (web/statDash.js);
  // over the cameras where a page's panels float over them (Studio)
  let dash = null;
  let dashGone = false;
  import('/web/statDash.js').then(({ attachStatDash }) => {
    if (dashGone) return;
    dash = attachStatDash({ stage, videos, main, over: stepsFixed });
  }).catch(() => { /* without it */ });
  cleanups.push(() => { dashGone = true; dash?.destroy(); });

  return {
    destroy() {
      resetAll();
      for (const fn of cleanups.splice(0)) { try { fn(); } catch { /* gone */ } }
    },
    /** Redraw after the page swapped which camera is the main one. */
    refresh: sync
  };
}
