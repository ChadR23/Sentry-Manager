// Saved camera layouts: three slots per interface, kept in this browser.
// A slot holds how the Viewer's cameras are laid out (which is large, the
// grid, the heads-up display: whatever the interface passes). Tap a slot to
// use it; hold it (or Shift-click) to save the current layout there. An
// empty slot saves on the first tap.
//
//   const slots = createLayoutSlots(el, {
//     key: 'horizon',                  // one set per interface
//     get: () => ({ main, grid, hud }),
//     apply: (layout) => …,
//     describe: (layout) => 'Front large'   // the slot's tooltip
//   });

const CSS = `
.sentry-ls{display:inline-flex;align-items:center;gap:4px}
.sentry-ls>span{font-size:12px;opacity:.75;margin-right:2px}
.sentry-ls button{all:unset;box-sizing:border-box;cursor:pointer;min-width:30px;height:30px;padding:0 8px;border-radius:7px;text-align:center;
  border:1px solid rgba(127,127,127,.5);font:700 13px/28px system-ui,sans-serif;-webkit-user-select:none;user-select:none;-webkit-touch-callout:none}
.sentry-ls button.empty{opacity:.55;border-style:dashed}
.sentry-ls button.on{background:rgba(127,127,127,.28)}
.sentry-ls button:focus-visible{outline:2px solid currentColor;outline-offset:2px}
.sentry-ls .ls-msg{font-size:12px;opacity:.85;min-width:0}
@media (max-width:700px){.sentry-ls>span:first-child{display:none}}
`;
const SLOTS = 3;

export function createLayoutSlots(el, { key, get, apply, describe = () => '' }) {
  if (!el) return { destroy() {} };
  if (!document.getElementById('sentry-ls-css')) {
    const style = document.createElement('style');
    style.id = 'sentry-ls-css';
    style.textContent = CSS;
    document.head.appendChild(style);
  }
  const storeKey = `sentry-layouts:${key}`;
  const read = () => { try { return JSON.parse(localStorage.getItem(storeKey) || '[]'); } catch { return []; } };
  const write = (list) => { try { localStorage.setItem(storeKey, JSON.stringify(list)); } catch { /* not kept */ } };
  const box = document.createElement('div');
  box.className = 'sentry-ls';
  box.setAttribute('role', 'group');
  box.setAttribute('aria-label', 'Saved camera layouts');
  el.appendChild(box);
  if (getComputedStyle(el).display.includes('flex')) el.style.flexWrap = 'wrap';
  let msgTimer = 0;
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

  function draw(msg = '') {
    const list = read();
    let now = null;
    try { now = get(); } catch { /* not ready */ }
    box.innerHTML = `<span>Layouts</span>${Array.from({ length: SLOTS }, (_, i) => {
      const l = list[i];
      const tip = l ? `Layout ${i + 1}: ${describe(l)}. Tap to use; hold or Shift-click to save the current layout here.` : `Empty: tap to save the current layout as layout ${i + 1}.`;
      return `<button type="button" data-slot="${i}" class="${l ? '' : 'empty'}${l && now && same(l, now) ? ' on' : ''}" title="${tip.replace(/"/g, '&quot;')}" aria-label="${tip.replace(/"/g, '&quot;')}">${i + 1}</button>`;
    }).join('')}<span class="ls-msg" role="status">${msg}</span>`;
    clearTimeout(msgTimer);
    if (msg) msgTimer = setTimeout(() => draw(), 2500);
  }
  function save(i) {
    const list = read();
    list[i] = get();
    write(list);
    draw(`Saved as ${i + 1}`);
  }
  function use(i) {
    const l = read()[i];
    if (!l) { save(i); return; }
    apply(l);
    draw();
  }

  // hold to save (touch and mouse), tap to use
  let hold = null;
  let held = false;
  box.addEventListener('pointerdown', (e) => {
    const b = e.target.closest('[data-slot]');
    if (!b) return;
    held = false;
    hold = setTimeout(() => { held = true; save(Number(b.dataset.slot)); }, 600);
  });
  const stop = () => { clearTimeout(hold); hold = null; };
  box.addEventListener('pointerup', stop);
  box.addEventListener('pointerleave', stop);
  box.addEventListener('pointercancel', stop);
  box.addEventListener('contextmenu', (e) => { if (e.target.closest('[data-slot]')) e.preventDefault(); });
  box.addEventListener('click', (e) => {
    const b = e.target.closest('[data-slot]');
    if (!b) return;
    if (held) { held = false; return; }
    const i = Number(b.dataset.slot);
    if (e.shiftKey) save(i); else use(i);
  });
  draw();
  return { refresh: () => draw(), destroy() { clearTimeout(msgTimer); box.remove(); } };
}
