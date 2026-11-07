// Keeping the cameras in step while they play, shared by the interface
// packs. A small drift is closed by playing that camera up to 10% faster or
// slower for a moment (no jump, no stutter); only one of over a quarter
// second is jumped. Before, any drift past 0.15-0.25 s was jumped, so the
// cameras wandered up to about 0.1 s apart and corrected with a visible
// skip; now they stay within a few milliseconds.
// Call it for each camera every frame while playing.
export function syncTo(master, x, speed = 1) {
  const d = x.currentTime - master.currentTime;
  if (Math.abs(d) > 0.25) {
    // a camera still loading or seeking is left to finish: jumping it again
    // starts its loading over, and it falls further behind (after a clip
    // change it could stay half a second out for a while)
    if (x.seeking || x.readyState < 3) return;
    x.currentTime = master.currentTime;
    if (x.playbackRate !== speed) x.playbackRate = speed;
    return;
  }
  const want = Math.abs(d) < 0.005 ? speed : speed * Math.max(0.9, Math.min(1.1, 1 - d * 2));
  if (Math.abs(x.playbackRate - want) > 0.004) x.playbackRate = want;
}

/**
 * Every camera ready to play where it is (HAVE_FUTURE_DATA), or `ms` passed:
 * call before starting them together after a clip change or a jump, so the
 * first frames move as one instead of the ready ones running ahead.
 */
export function readyTogether(videos, ms = 1500) {
  const waiting = videos.filter((v) => v && v.getAttribute('src') && v.readyState < 3 && !v.error);
  if (!waiting.length) return Promise.resolve();
  return new Promise((done) => {
    let left = waiting.length;
    const offs = [];
    const finish = () => { clearTimeout(timer); for (const off of offs) off(); done(); };
    const timer = setTimeout(finish, ms);
    for (const v of waiting) {
      const one = () => { v.removeEventListener('canplay', one); v.removeEventListener('error', one); if (--left === 0) finish(); };
      v.addEventListener('canplay', one);
      v.addEventListener('error', one);
      offs.push(() => { v.removeEventListener('canplay', one); v.removeEventListener('error', one); });
    }
  });
}

/**
 * The next clip, loaded ahead: hidden players open the next minute's cameras
 * in its last `lead` seconds, so the change to it starts at once (the
 * browser shares what they loaded with the page's own players of the same
 * address). const ahead = clipAhead(); ahead.follow(mainVideo, () => urls);
 * ahead.clear() on a clip change; ahead.destroy() when leaving.
 */
export function clipAhead({ lead = 12 } = {}) {
  const box = document.createElement('div');
  box.setAttribute('aria-hidden', 'true');
  box.style.cssText = 'position:fixed;left:-10px;top:-10px;width:1px;height:1px;overflow:hidden;opacity:0;pointer-events:none';
  const players = new Map(); // url -> video
  let watched = null;
  let urlsOf = null;
  let warmed = false;
  function warm(urls) {
    const want = new Set((urls || []).filter(Boolean).slice(0, 8));
    for (const [u, v] of players) {
      if (want.has(u)) continue;
      v.removeAttribute('src');
      v.load();
      v.remove();
      players.delete(u);
    }
    if (want.size && !box.isConnected) document.body.appendChild(box);
    for (const u of want) {
      if (players.has(u)) continue;
      const v = document.createElement('video');
      v.muted = true;
      v.playsInline = true;
      v.preload = 'auto';
      v.src = u;
      box.appendChild(v);
      players.set(u, v);
    }
  }
  const onTime = () => {
    const m = watched;
    if (!m || warmed || !(m.duration > 0) || m.paused) return;
    if (m.duration - m.currentTime <= lead) { warmed = true; warm(urlsOf?.() || []); }
  };
  return {
    /** Load `next()`'s addresses when `master` is in its last seconds. */
    follow(master, next) {
      watched?.removeEventListener('timeupdate', onTime);
      watched = master || null;
      urlsOf = next;
      warmed = false;
      watched?.addEventListener('timeupdate', onTime);
    },
    /** Drop what was loaded ahead (the clip changed, or it is not needed). */
    clear() { warmed = false; warm([]); },
    warm,
    destroy() { watched?.removeEventListener('timeupdate', onTime); watched = null; warm([]); box.remove(); }
  };
}
