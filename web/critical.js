'use strict';

// The critical-update bar. The server puts this script into every page it
// serves (the built-in interface, the Studio pages and every interface pack),
// so a critical update shows whatever interface is chosen. It asks
// /api/updates every 10 minutes; when the newest image is marked critical
// (CRITICAL_UPDATE.txt when it was built) and is not installed yet, a red bar
// sits at the very top of the page. It cannot be closed: it goes away by
// itself once the update is installed.
(() => {
  // a page shown inside another page (the Encoder tab) leaves it to the outer one
  try {
    if (window.top !== window.self) return;
  } catch {
    return;
  }
  const RECHECK_MS = 10 * 60 * 1000;
  const COMMAND = 'docker compose pull && docker compose up -d';
  const ID = 'sentry-critical-update';
  let bar = null;
  let spacer = null;
  let reasonEl = null;
  let collapsed = false;

  const css = `
#${ID}{position:fixed;top:0;left:0;right:0;z-index:2147483647;box-sizing:border-box;margin:0;
  padding:10px max(16px,env(safe-area-inset-right)) 10px max(16px,env(safe-area-inset-left));
  padding-top:max(10px,env(safe-area-inset-top));background:#b3001b;color:#fff;
  font:500 14px/1.4 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;text-align:left;
  box-shadow:0 2px 0 #ffd400,0 6px 18px rgba(0,0,0,.45);border-bottom:2px solid #ffd400;
  display:flex;gap:12px;align-items:flex-start;overflow-wrap:anywhere;color-scheme:dark;cursor:default}
#${ID} *{box-sizing:border-box;color:inherit;font-family:inherit;letter-spacing:normal;text-transform:none}
#${ID} svg{flex:none;width:26px;height:26px;margin-top:1px}
#${ID} .cu-body{flex:1;min-width:0;display:flex;flex-wrap:wrap;gap:4px 14px;align-items:baseline}
#${ID} .cu-title{font-weight:800;font-size:16px;text-transform:uppercase;letter-spacing:.02em}
#${ID} .cu-reason{flex:1 1 260px;min-width:0}
#${ID} .cu-how{flex:1 1 100%;display:flex;flex-wrap:wrap;gap:4px 10px;align-items:center;font-size:13px}
#${ID} code{font:600 13px/1.4 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;background:rgba(0,0,0,.35);
  border:1px solid rgba(255,255,255,.35);border-radius:4px;padding:2px 6px;user-select:all;-webkit-user-select:all;max-width:100%}
#${ID}.cu-slim .cu-reason,#${ID}.cu-slim .cu-how{display:none}
#${ID}.cu-slim{padding-bottom:6px;cursor:pointer}
@media (prefers-reduced-motion:no-preference){
  #${ID} svg{animation:cu-pulse 1.6s ease-in-out infinite}
  @keyframes cu-pulse{50%{transform:scale(1.15)}}
}
@media (max-width:640px){
  #${ID}{font-size:13px;gap:10px;padding-top:max(8px,env(safe-area-inset-top));padding-bottom:8px}
  #${ID} svg{width:22px;height:22px}
  #${ID} .cu-title{font-size:14px}
  #${ID} .cu-how,#${ID} code{font-size:12px}
}
@media print{#${ID}{position:static}}`;

  function build() {
    const style = document.createElement('style');
    style.textContent = css;
    document.head.appendChild(style);
    bar = document.createElement('div');
    bar.id = ID;
    bar.setAttribute('role', 'alert');
    const svgNs = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(svgNs, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('aria-hidden', 'true');
    const tri = document.createElementNS(svgNs, 'path');
    tri.setAttribute('d', 'M12 2 1 21h22L12 2Z');
    tri.setAttribute('fill', '#ffd400');
    const mark = document.createElementNS(svgNs, 'path');
    mark.setAttribute('d', 'M11 9h2v6h-2zM11 17h2v2h-2z');
    mark.setAttribute('fill', '#000');
    svg.append(tri, mark);
    const body = document.createElement('div');
    body.className = 'cu-body';
    const title = document.createElement('strong');
    title.className = 'cu-title';
    title.textContent = 'Critical update: install now';
    reasonEl = document.createElement('span');
    reasonEl.className = 'cu-reason';
    const how = document.createElement('span');
    how.className = 'cu-how';
    const run = document.createElement('span');
    run.textContent = 'Run where you set it up:';
    const code = document.createElement('code');
    code.textContent = COMMAND;
    const nas = document.createElement('span');
    nas.textContent = 'TrueNAS: docker pull the image in System → Shell, then Stop and Start the app.';
    how.append(run, code, nas);
    body.append(title, reasonEl, how);
    bar.append(svg, body);
    // keeps the page's own content below the bar
    spacer = document.createElement('div');
    spacer.setAttribute('aria-hidden', 'true');
    spacer.style.cssText = 'display:block;width:100%;flex:none;margin:0;padding:0;border:0';
    bar.addEventListener('click', () => setCollapsed(false));
  }

  const phone = () => window.matchMedia('(max-width: 640px)').matches;
  function setCollapsed(on) {
    if (!bar || collapsed === on) return;
    collapsed = on;
    bar.classList.toggle('cu-slim', on);
    fit();
  }
  function fit() {
    if (!bar?.isConnected) return;
    const h = Math.ceil(bar.getBoundingClientRect().height);
    spacer.style.height = `${h}px`;
    document.documentElement.style.setProperty('--critical-update-bar', `${h}px`);
  }

  function show(critical) {
    if (!bar) build();
    reasonEl.textContent = critical.reason || '';
    if (!bar.isConnected) {
      document.body.prepend(spacer);
      document.body.prepend(bar);
      document.documentElement.classList.add('has-critical-update');
    }
    fit();
  }
  function hide() {
    bar?.remove();
    spacer?.remove();
    document.documentElement.classList.remove('has-critical-update');
    document.documentElement.style.removeProperty('--critical-update-bar');
  }

  async function check() {
    try {
      const res = await fetch('/api/updates', { credentials: 'same-origin', headers: { 'X-Requested-With': 'sentry-six-manager' }, cache: 'no-store' });
      if (!res.ok) return;
      const st = await res.json();
      if (st && st.critical && typeof st.critical.reason === 'string') show(st.critical);
      else hide();
    } catch {
      // offline or signed out: try again later
    }
  }

  function start() {
    check();
    setInterval(check, RECHECK_MS);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) check(); });
    window.addEventListener('resize', fit);
    // on phones it shrinks to a slim bar while scrolling (still there); a tap opens it again
    let lastY = 0;
    document.addEventListener('scroll', (e) => {
      if (!bar?.isConnected || !phone()) return;
      const t = e.target === document ? document.scrollingElement : e.target;
      const y = t?.scrollTop || 0;
      if (y > 40 && y > lastY) setCollapsed(true);
      else if (y < 10) setCollapsed(false);
      lastY = y;
    }, { capture: true, passive: true });
  }
  if (document.body) start();
  else document.addEventListener('DOMContentLoaded', start);
})();

// The startup check's bar (server/health.js): when a check that runs a minute
// after every start failed (the database, the data folder, ffmpeg, the GPU
// encoder, a footage share), an amber bar at the top of every page says what
// and links to Health. It can be closed for this visit; it goes away by
// itself once the next check passes. It is in the page (it scrolls away with
// it), under the red bar's spacer. Like the red bar's --critical-update-bar,
// its height is on <html> as --startup-check-bar (and the class
// has-startup-check) while it shows, so an interface can make room for it.
(() => {
  try {
    if (window.top !== window.self) return;
  } catch {
    return;
  }
  const ID = 'sentry-health-bar';
  const css = `
#${ID}{position:relative;z-index:2147483646;box-sizing:border-box;margin:0;display:flex;gap:10px;align-items:center;flex-wrap:wrap;
  padding:8px max(14px,env(safe-area-inset-right)) 8px max(14px,env(safe-area-inset-left));background:#8a5a00;color:#fff;
  font:500 14px/1.4 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;border-bottom:2px solid #ffc94a;color-scheme:dark}
#${ID} *{box-sizing:border-box;color:inherit;font-family:inherit;letter-spacing:normal;text-transform:none}
#${ID} b{font-weight:800}
#${ID} span{flex:1 1 240px;min-width:0;overflow-wrap:anywhere}
#${ID} a,#${ID} button{all:unset;cursor:pointer;font-weight:700;padding:4px 10px;border-radius:6px;border:1px solid rgba(255,255,255,.6)}
#${ID} a:focus-visible,#${ID} button:focus-visible{outline:2px solid #fff;outline-offset:2px}
@media (pointer:coarse){#${ID} a,#${ID} button{padding:8px 12px}}
@media print{#${ID}{display:none}}`;
  let bar = null;
  let watch = null;
  const key = (problems) => `sentry-health-closed:${problems.map((p) => p.label).join('|')}`;
  const root = document.documentElement;
  function fit() {
    if (!bar?.isConnected) return;
    root.style.setProperty('--startup-check-bar', `${Math.ceil(bar.getBoundingClientRect().height)}px`);
  }
  function hide() {
    watch?.disconnect();
    watch = null;
    bar?.remove();
    bar = null;
    root.classList.remove('has-startup-check');
    root.style.removeProperty('--startup-check-bar');
  }
  function show(problems) {
    try { if (sessionStorage.getItem(key(problems))) return; } catch { /* shown */ }
    if (!document.getElementById(`${ID}-css`)) {
      const style = document.createElement('style');
      style.id = `${ID}-css`;
      style.textContent = css;
      document.head.appendChild(style);
    }
    if (!bar) {
      bar = document.createElement('div');
      bar.id = ID;
      bar.setAttribute('role', 'status');
      const red = document.getElementById('sentry-critical-update');
      if (red?.nextSibling) red.nextSibling.after(bar); else document.body.prepend(bar);
    }
    bar.textContent = '';
    const text = document.createElement('span');
    const b = document.createElement('b');
    b.textContent = problems.length === 1 ? 'Startup check found a problem: ' : `Startup check found ${problems.length} problems: `;
    text.append(b, problems.map((p) => `${p.label}${p.detail ? ` (${p.detail})` : ''}`).join('; '));
    const open = document.createElement('a');
    open.href = '/#/health';
    open.textContent = 'Open Health';
    const close = document.createElement('button');
    close.type = 'button';
    close.textContent = 'Close';
    close.setAttribute('aria-label', 'Close this bar for now');
    close.addEventListener('click', () => { try { sessionStorage.setItem(key(problems), '1'); } catch { /* until reload */ } hide(); });
    bar.append(text, open, close);
    root.classList.add('has-startup-check');
    fit();
    // (its height changes as the window narrows and the text wraps)
    if (!watch && window.ResizeObserver) { watch = new window.ResizeObserver(fit); watch.observe(bar); }
  }
  async function check() {
    try {
      const res = await fetch('/api/health/banner', { credentials: 'same-origin', headers: { 'X-Requested-With': 'sentry-six-manager' }, cache: 'no-store' });
      if (!res.ok) return;
      const { problems } = await res.json();
      if (Array.isArray(problems) && problems.length) show(problems);
      else hide();
    } catch {
      // offline or signed out: try again later
    }
  }
  function start() {
    check();
    setTimeout(check, 75_000); // the startup check runs a minute after the app starts
    setInterval(check, 10 * 60 * 1000);
    window.addEventListener('resize', fit);
  }
  if (document.body) start();
  else document.addEventListener('DOMContentLoaded', start);
})();
