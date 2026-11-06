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
