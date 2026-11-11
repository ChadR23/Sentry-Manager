'use strict';

// The public demo (DEMO=1 only; server/demoMode.js): visitors are signed in
// automatically; this adds a small banner on every page and a notice when a
// feature the demo turns off is refused. Loaded first in <head> by the
// server, in every interface.

(() => {
  const origFetch = window.fetch.bind(window);
  let info = null;
  const ready = origFetch('/api/auth/me', { credentials: 'same-origin' }).then((r) => r.json()).then((me) => { info = me.demo || null; return info; }).catch(() => null);

  const css = (el, rules) => { Object.assign(el.style, rules); return el; };
  const font = 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';

  let toastTimer = null;
  function notice(text) {
    let t = document.getElementById('demo-notice');
    if (!t) {
      t = css(document.createElement('div'), {
        position: 'fixed', left: '50%', bottom: '44px', transform: 'translateX(-50%)', zIndex: '2147483647', maxWidth: 'calc(100vw - 32px)',
        background: '#3b2a06', color: '#ffe3a3', border: '1px solid #8a6514', borderRadius: '10px', padding: '9px 14px', font: `500 13.5px/1.35 ${font}`, boxShadow: '0 6px 24px rgba(0,0,0,.35)'
      });
      t.id = 'demo-notice';
      t.setAttribute('role', 'status');
      document.body.appendChild(t);
    }
    t.textContent = text;
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.hidden = true; }, 4000);
  }
  // a refused demo feature: say so, whichever interface asked
  window.fetch = async (...args) => {
    const res = await origFetch(...args);
    if (res.status === 403) {
      res.clone().json().then((d) => { if (d?.code === 'DEMO_LOCKED') notice(`${d.error} (${d.feature})`); }).catch(() => {});
    }
    return res;
  };

  function banner(minutes) {
    if (document.getElementById('demo-banner')) return;
    const b = css(document.createElement('div'), {
      position: 'fixed', left: '50%', bottom: '8px', transform: 'translateX(-50%)', zIndex: '2147483646', pointerEvents: 'none', whiteSpace: 'nowrap',
      background: 'rgba(20,24,33,.86)', color: '#e8ecf3', border: '1px solid rgba(255,255,255,.18)', borderRadius: '999px', padding: '4px 12px', font: `500 12px/1.4 ${font}`
    });
    b.id = 'demo-banner';
    b.textContent = `Demo: changes reset every ${minutes} minutes`;
    document.body.appendChild(b);
  }

  const onReady = (fn) => (document.readyState === 'loading' ? document.addEventListener('DOMContentLoaded', fn, { once: true }) : fn());
  onReady(async () => {
    const demo = await ready;
    if (!demo) return;
    banner(demo.resetMinutes);
  });
})();
