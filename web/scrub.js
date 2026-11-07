// Fast timeline dragging, shared by the built-in Viewer and the interface
// packs. Two parts:
//
// 1. Previews: while the timeline is dragged, every camera shows a small
//    frame of the second under the pointer at once, from a grid the server
//    makes per clip and camera (server/scrubFrames.js, GET /api/scrub). It
//    works across clips too, so the Viewer only has to load another clip
//    when the drag ends.
// 2. One seek at a time: a camera that is still seeking is not sent the next
//    position; it gets the latest one as soon as it is done, instead of every
//    move cancelling the last before a frame is shown.
//
//   const scrub = createScrubber();
//   // while dragging, the clip under the pointer and the time in it:
//   scrub.show([{ video, src: clip.files.front }, ...], t);
//   scrub.seek(videos, t);          // same clip: the real seek, one at a time
//   // when the drag ends, after the Viewer's own seek or clip change:
//   scrub.release(videos);          // previews give way once each video shows its frame
//   scrub.warm([paths...]);         // fetch grids ahead (the clip opened, its neighbours)
//
// A `src` is a clip's file path or its /api/media URL.

const COLS = 10;
const ROWS = 7;
const MAX_IMAGES = 60;

const images = new Map(); // path -> { img, ready, failed, waiters }

function pathOf(src) {
  if (!src) return null;
  if (src.startsWith('/') && !src.startsWith('/api/')) return src;
  try {
    const u = new URL(src, location.href);
    return u.pathname === '/api/media' || u.pathname === '/api/scrub' ? u.searchParams.get('path') : null;
  } catch {
    return null;
  }
}

function grid(path) {
  if (!path) return null;
  let e = images.get(path);
  if (e) {
    images.delete(path);
    images.set(path, e); // most recently used last
    return e;
  }
  const img = new Image();
  img.decoding = 'async';
  e = { img, ready: false, failed: false, waiters: new Set() };
  img.onload = () => {
    e.ready = img.naturalWidth > 0;
    // previews asked for before the grid had arrived
    for (const fn of e.waiters) fn();
    e.waiters.clear();
  };
  img.onerror = () => { e.failed = true; images.delete(path); };
  img.src = `/api/scrub?path=${encodeURIComponent(path)}`;
  images.set(path, e);
  while (images.size > MAX_IMAGES) images.delete(images.keys().next().value);
  return e;
}

// The preview over the timeline, as video sites have it: a small frame of
// the second under the pointer, with its time, above the bar. With a mouse
// it follows the pointer without a click; on a touch screen it shows while
// a finger drags. `at(clientX)` says what is there: { src, t, label } (src
// a clip's path or /api/media URL, t the second in it), or null for nothing.
//
//   const tip = attachTimelineTip(timelineEl, (x) => ({ src, t, label }));
//   tip.destroy();
const TIP_WIDTH = 176;

// The time of day `off` seconds into a clip named by its start
// (…_HH-MM-SS), as "HH-MM-SS" for an interface's own clock format, or null.
export function timeAfter(key, off) {
  const m = /(\d{2})-(\d{2})-(\d{2})(?:-[a-z_]+)?(?:\.mp4)?$/i.exec(String(key || ''));
  if (!m) return null;
  const at = (Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) + Math.floor(Math.max(0, off))) % 86400;
  const p2 = (n) => String(n).padStart(2, '0');
  return `${p2(Math.floor(at / 3600))}-${p2(Math.floor(at / 60) % 60)}-${p2(at % 60)}`;
}
export function attachTimelineTip(bar, at, { width = TIP_WIDTH } = {}) {
  if (!bar) return { destroy() {} };
  const tip = document.createElement('div');
  tip.className = 'sentry-tip';
  tip.setAttribute('aria-hidden', 'true');
  tip.style.cssText = 'position:fixed;left:0;top:0;z-index:2147483000;pointer-events:none;display:none;'
    + 'flex-direction:column;align-items:center;gap:4px;transition:opacity .08s;';
  const pic = document.createElement('div');
  pic.className = 'sentry-tip-frame';
  pic.style.cssText = `width:${width}px;height:${Math.round(width * 9 / 16)}px;border:2px solid rgba(255,255,255,.92);border-radius:6px;`
    + 'background:#000 no-repeat;box-shadow:0 4px 18px rgba(0,0,0,.55);overflow:hidden;';
  const label = document.createElement('div');
  label.className = 'sentry-tip-time';
  label.style.cssText = 'font:600 12px/1.2 system-ui,sans-serif;color:#fff;padding:2px 7px;border-radius:4px;'
    + 'background:rgba(0,0,0,.72);font-variant-numeric:tabular-nums;white-space:nowrap;';
  tip.append(pic, label);
  document.body.appendChild(tip);

  let want = null; // { path, t } shown or awaited
  let dragging = false;

  function paint(path, t) {
    const g = grid(path);
    if (!g?.ready) {
      pic.style.backgroundImage = '';
      if (g) g.waiters.add(() => { if (want && want.path === path) paint(path, want.t); });
      return;
    }
    const cw = g.img.naturalWidth / COLS;
    const ch = g.img.naturalHeight / ROWS;
    const h = Math.round(width * ch / cw);
    pic.style.height = `${h}px`;
    const i = Math.max(0, Math.min(COLS * ROWS - 1, Math.floor(t)));
    Object.assign(pic.style, {
      backgroundImage: `url("${g.img.src}")`,
      backgroundSize: `${width * COLS}px ${h * ROWS}px`,
      backgroundPosition: `${-(i % COLS) * width}px ${-Math.floor(i / COLS) * h}px`
    });
  }

  function showAt(x) {
    const what = at(x);
    const path = what && pathOf(what.src);
    if (!what || !path) { hide(); return; }
    want = { path, t: what.t };
    label.textContent = what.label || '';
    label.style.display = what.label ? '' : 'none';
    paint(path, what.t);
    tip.style.display = 'flex';
    const r = bar.getBoundingClientRect();
    const w = tip.offsetWidth;
    const left = Math.max(6, Math.min(window.innerWidth - w - 6, x - w / 2));
    const top = Math.max(6, r.top - tip.offsetHeight - 10);
    tip.style.transform = `translate(${Math.round(left)}px,${Math.round(top)}px)`;
  }

  function hide() {
    want = null;
    tip.style.display = 'none';
  }

  const onMove = (e) => {
    // a mouse shows it on hover; a finger or pen only while dragging
    if (e.pointerType === 'mouse' || dragging) showAt(e.clientX);
  };
  const onDown = (e) => { dragging = true; showAt(e.clientX); };
  const onUp = (e) => { dragging = false; if (e.pointerType !== 'mouse') hide(); };
  const onLeave = () => { if (!dragging) hide(); };
  bar.addEventListener('pointermove', onMove);
  bar.addEventListener('pointerdown', onDown);
  bar.addEventListener('pointerup', onUp);
  bar.addEventListener('pointercancel', onUp);
  bar.addEventListener('pointerleave', onLeave);
  window.addEventListener('scroll', hide, { passive: true, capture: true });
  return {
    destroy() {
      bar.removeEventListener('pointermove', onMove);
      bar.removeEventListener('pointerdown', onDown);
      bar.removeEventListener('pointerup', onUp);
      bar.removeEventListener('pointercancel', onUp);
      bar.removeEventListener('pointerleave', onLeave);
      window.removeEventListener('scroll', hide, { capture: true });
      tip.remove();
    },
    hide
  };
}

export function createScrubber() {
  const layers = new WeakMap(); // video -> preview element
  const seeks = new WeakMap(); // video -> { want, sent }
  const shown = new Set();
  const wanted = new WeakMap(); // video -> the preview last asked for
  const released = new WeakSet(); // its drag or load is over: the preview goes when the video shows a frame
  let settling = 0;
  let settleStart = 0;

  // previews of released videos give way once each video shows its frame
  // (restarted when a late preview appears)
  function settle(restart = true) {
    if (restart) settleStart = performance.now();
    cancelAnimationFrame(settling);
    const check = () => {
      const age = performance.now() - settleStart;
      for (const v of [...shown]) {
        if (released.has(v) && age > 60 && !v.seeking && v.readyState >= 2) hideOne(v, true);
      }
      const left = [...shown].some((v) => released.has(v));
      if (left && age < 8000) settling = requestAnimationFrame(check);
      else if (left) for (const v of [...shown]) if (released.has(v)) hideOne(v, true);
    };
    settling = requestAnimationFrame(check);
  }

  function layerFor(video) {
    let el = layers.get(video);
    if (el && el.isConnected) return el;
    const host = video.parentElement;
    if (!host) return null;
    if (getComputedStyle(host).position === 'static') host.style.position = 'relative';
    el = document.createElement('div');
    el.className = 'sentry-scrub';
    el.setAttribute('aria-hidden', 'true');
    el.style.cssText = 'position:absolute;pointer-events:none;background-repeat:no-repeat;z-index:0;display:none';
    video.after(el);
    layers.set(video, el);
    return el;
  }

  // the frame of second t, fitted to the video as the video itself is
  // (object-fit), over exactly the video's box, mirrored if the video is
  function draw(video, path, t) {
    const g = grid(path);
    const el = layerFor(video);
    if (!el) return;
    if (!g?.ready) {
      hideOne(video);
      // drawn when the grid arrives, if this is still wanted and the video
      // still has nothing to show
      if (g) {
        wanted.set(video, { path, t });
        g.waiters.add(() => {
          const w = wanted.get(video);
          if (w && w.path === path && !showsIt(video, path, w.t) && !(video.readyState >= 2 && !video.seeking && pathOf(video.currentSrc) === path)) {
            draw(video, path, w.t);
            if (released.has(video)) settle();
          }
        });
      }
      return;
    }
    const W = video.offsetWidth;
    const H = video.offsetHeight;
    if (!W || !H) { hideOne(video); return; }
    const cs = getComputedStyle(video);
    const cw = g.img.naturalWidth / COLS;
    const ch = g.img.naturalHeight / ROWS;
    let fw = W;
    let fh = H;
    if (cs.objectFit !== 'fill') {
      const s = cs.objectFit === 'cover' ? Math.max(W / cw, H / ch) : Math.min(W / cw, H / ch);
      fw = cw * s;
      fh = ch * s;
    }
    const i = Math.max(0, Math.min(COLS * ROWS - 1, Math.floor(t)));
    const ox = (W - fw) / 2 - (i % COLS) * fw;
    const oy = (H - fh) / 2 - Math.floor(i / COLS) * fh;
    Object.assign(el.style, {
      left: `${video.offsetLeft}px`, top: `${video.offsetTop}px`, width: `${W}px`, height: `${H}px`,
      backgroundImage: `url("${g.img.src}")`, backgroundSize: `${fw * COLS}px ${fh * ROWS}px`,
      backgroundPosition: `${ox}px ${oy}px`, transform: cs.transform === 'none' ? '' : cs.transform,
      borderRadius: cs.borderRadius, display: 'block'
    });
    shown.add(video);
  }

  function hideOne(video, forget = false) {
    if (forget) wanted.delete(video);
    const el = layers.get(video);
    if (el) el.style.display = 'none';
    shown.delete(video);
  }

  // the video already shows (about) this frame of this clip: no preview
  function showsIt(video, path, t) {
    return pathOf(video.currentSrc || video.src) === path && !video.seeking && video.readyState >= 2
      && Math.abs(video.currentTime - t) < 0.25;
  }

  function onSeeked(e) {
    const v = e.target;
    const s = seeks.get(v);
    if (s && s.want !== s.sent && Number.isFinite(s.want)) {
      s.sent = s.want;
      try { v.currentTime = s.want; } catch { /* not seekable yet */ }
    } else if (s && s.path && showsIt(v, s.path, s.want)) {
      hideOne(v);
    }
  }

  return {
    // previews of the clip under the pointer: [{ video, src }] and the time in that clip
    show(pairs, t) {
      cancelAnimationFrame(settling);
      for (const { video, src } of pairs) {
        if (!video) continue;
        released.delete(video);
        const path = pathOf(src);
        wanted.set(video, path ? { path, t } : null);
        const s = seeks.get(video);
        if (s) { s.path = path; s.want = s.want ?? t; }
        if (!path || showsIt(video, path, t)) hideOne(video);
        else draw(video, path, t);
      }
    },
    // the real seek within the clip that is loaded, one at a time per video
    seek(videos, t) {
      for (const v of videos) {
        if (!v) continue;
        let s = seeks.get(v);
        if (!s) {
          s = { want: t, sent: null, path: null };
          seeks.set(v, s);
          v.addEventListener('seeked', onSeeked);
        }
        s.want = t;
        if (!v.seeking) {
          s.sent = t;
          try { v.currentTime = t; } catch { /* not seekable yet */ }
        }
      }
    },
    // the drag ended: each preview goes once its video shows the frame
    release(videos) {
      for (const v of videos) {
        if (!v) continue;
        const s = seeks.get(v);
        if (s) s.want = s.sent = null;
        released.add(v);
      }
      settle();
    },
    warm(srcs) {
      for (const src of srcs || []) grid(pathOf(src));
    },
    hide() {
      cancelAnimationFrame(settling);
      for (const v of [...shown]) hideOne(v);
    }
  };
}

// Flip through a recording on its thumbnail: moving the mouse across a
// recording's picture shows its frames from start to end (the front camera's
// preview grids), as streaming sites do. One listener for a whole list:
//
//   hoverFrames(listEl, '.thumb');   // which recording: the thumbnail's own URL
//   hoverFrames(listEl, '.thumb', (thumb) => ({ vehicleId, recordingId }));
//
// The picture's box gets a layer on top while the mouse is over it.
const FLIP_CLIP_SECONDS = 60;
const flipClips = new Map(); // `${vehicle}/${recording}` -> Promise<[front clip paths]>
function frontClipsOf(vehicleId, recordingId) {
  const key = `${vehicleId}/${recordingId}`;
  if (!flipClips.has(key)) {
    flipClips.set(key, fetch(`/api/vehicles/${encodeURIComponent(vehicleId)}/recordings/${encodeURIComponent(recordingId)}`, { credentials: 'same-origin' })
      .then((r) => (r.ok ? r.json() : { files: [] }))
      .then((d) => (d.files || []).map((f) => f.path).filter((p) => /-front\.mp4$/i.test(p || '')).sort())
      .catch(() => []));
    if (flipClips.size > 300) flipClips.delete(flipClips.keys().next().value);
  }
  return flipClips.get(key);
}

const THUMB_URL = /\/api\/vehicles\/([^/]+)\/recordings\/([^/]+)\/thumbnail/;
function fromThumbnail(el) {
  const img = el.matches?.('img') ? el : el.querySelector?.('img[src*="/thumbnail"]');
  const m = img && THUMB_URL.exec(img.getAttribute('src') || '');
  return m ? { vehicleId: decodeURIComponent(m[1]), recordingId: decodeURIComponent(m[2]) } : null;
}

export function hoverFrames(root, selector, info = fromThumbnail) {
  if (!root) return { destroy() {} };
  let box = null;
  let layer = null;
  let clips = null;
  let token = 0;
  let lastX = 0;
  const stop = () => {
    token++;
    layer?.remove();
    layer = null;
    box = null;
    clips = null;
  };
  function paint() {
    if (!box || !clips?.length) return;
    const r = box.getBoundingClientRect();
    const f = Math.max(0, Math.min(0.999, (lastX - r.left) / r.width));
    const pos = f * clips.length;
    const i = Math.floor(pos);
    const t = (pos - i) * FLIP_CLIP_SECONDS;
    const g = grid(clips[i]);
    if (!g?.ready) {
      if (g) g.waiters.add(() => { if (box && clips?.[i] === clips[i]) paint(); });
      return;
    }
    if (!layer) {
      layer = document.createElement('div');
      layer.className = 'sentry-flip';
      layer.setAttribute('aria-hidden', 'true');
      layer.style.cssText = 'position:absolute;inset:0;pointer-events:none;background-repeat:no-repeat;z-index:1;border-radius:inherit;overflow:hidden';
      const bar = document.createElement('i');
      bar.style.cssText = 'position:absolute;left:0;bottom:0;height:3px;background:rgba(255,255,255,.9)';
      layer.appendChild(bar);
      if (getComputedStyle(box).position === 'static') box.style.position = 'relative';
      box.appendChild(layer);
    }
    // the frame covers the box (as a cropped thumbnail does)
    const cw = g.img.naturalWidth / COLS;
    const ch = g.img.naturalHeight / ROWS;
    const s = Math.max(r.width / cw, r.height / ch);
    const fw = cw * s;
    const fh = ch * s;
    const n = Math.max(0, Math.min(COLS * ROWS - 1, Math.floor(t)));
    Object.assign(layer.style, {
      backgroundImage: `url("${g.img.src}")`,
      backgroundSize: `${fw * COLS}px ${fh * ROWS}px`,
      backgroundPosition: `${(r.width - fw) / 2 - (n % COLS) * fw}px ${(r.height - fh) / 2 - Math.floor(n / COLS) * fh}px`
    });
    layer.firstChild.style.width = `${(f * 100).toFixed(1)}%`;
  }
  const onMove = (e) => {
    if (e.pointerType !== 'mouse') return;
    const el = e.target.closest?.(selector);
    if (!el || !root.contains(el)) { if (box) stop(); return; }
    lastX = e.clientX;
    if (el !== box) {
      stop();
      box = el;
      const want = info(el);
      if (!want?.vehicleId || !want?.recordingId) return;
      const mine = token;
      frontClipsOf(want.vehicleId, want.recordingId).then((list) => {
        if (mine !== token) return;
        clips = list;
        // the grids of what the mouse can reach next
        for (const p of list.slice(0, 3)) grid(p);
        paint();
      });
      return;
    }
    paint();
  };
  const onLeave = (e) => { if (box && !box.contains(e.relatedTarget)) stop(); };
  root.addEventListener('pointermove', onMove);
  root.addEventListener('pointerout', onLeave);
  return {
    destroy() {
      stop();
      root.removeEventListener('pointermove', onMove);
      root.removeEventListener('pointerout', onLeave);
    }
  };
}
