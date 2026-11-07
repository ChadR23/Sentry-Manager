// Find moments: the day's hard braking, swerves and top speeds, from the
// speed index (GET /api/vehicles/:id/moments). Each interface's Viewer puts
// the list in its own page; picking one plays it there.
//
//   const moments = createMoments(el, {
//     clock: (hms) => …,           // "HH-MM-SS" in the pack's clock format
//     speedUnit: () => 'mph',      // or 'kmh'
//     onPick: ({ clip, second, path }) => …
//   });
//   moments.load(vehicleId, day);
//   moments.destroy();
//
// It is plain markup with classes (sentry-moments, -row, -kind, -value,
// -time, -note) and inherits the page's colours; a pack can style it.

import { timeAfter } from '/web/scrub.js';

const KIND = {
  brake: { label: 'Hard braking', color: '#ff5d5d' },
  swerve: { label: 'Swerve or sharp turn', color: '#ffb14a' },
  speed: { label: 'Top speed', color: '#4ab3ff' }
};

const CSS = `
.sentry-moments{display:flex;flex-direction:column;gap:2px;font-size:13px}
.sentry-moments-row{all:unset;box-sizing:border-box;display:grid;grid-template-columns:10px 1fr auto;gap:2px 10px;align-items:center;
  padding:7px 8px;border-radius:6px;cursor:pointer}
.sentry-moments-row:hover,.sentry-moments-row:focus-visible{background:rgba(127,127,127,.14)}
.sentry-moments-row i{width:10px;height:10px;border-radius:50%;grid-row:span 2}
.sentry-moments-kind{font-weight:600}
.sentry-moments-value{font-variant-numeric:tabular-nums;font-weight:600;text-align:right}
.sentry-moments-time{grid-column:2 / span 2;opacity:.7;font-variant-numeric:tabular-nums}
.sentry-moments-note{opacity:.7;margin:4px 0;line-height:1.4}
`;

function addCss() {
  if (document.getElementById('sentry-moments-css')) return;
  const style = document.createElement('style');
  style.id = 'sentry-moments-css';
  style.textContent = CSS;
  document.head.appendChild(style);
}

const esc = (t) => String(t).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const defaultClock = (hms) => {
  const [h, m, s] = hms.split('-').map(Number);
  return `${h % 12 || 12}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
};

export function createMoments(container, { clock = defaultClock, speedUnit = () => 'mph', onPick = () => {} } = {}) {
  addCss();
  const list = document.createElement('div');
  list.className = 'sentry-moments';
  container.appendChild(list);
  let items = [];
  let last = { moments: [] };
  let seq = 0;

  const value = (m) => {
    if (m.kind === 'speed') return speedUnit() === 'kmh' ? `${Math.round(m.value * 3.6)} km/h` : `${Math.round(m.value * 2.23694)} mph`;
    return `${(m.value / 9.81).toFixed(2)} g`;
  };

  function draw(data) {
    last = data;
    items = data.moments || [];
    const left = (data.clips || 0) - (data.indexed || 0);
    const pending = left > 0 ? `<p class="sentry-moments-note">Still reading ${left} of ${data.clips} clips in the background; more may appear.</p>` : '';
    if (!items.length) {
      list.innerHTML = `${pending}<p class="sentry-moments-note">${data.clips ? 'No hard braking or swerves this day.' : 'No clips with driving data this day.'}</p>`;
      return;
    }
    list.innerHTML = pending + items.map((m, i) => {
      const k = KIND[m.kind] || { label: m.kind, color: '#999' };
      const at = timeAfter(m.clip, m.second);
      return `<button type="button" class="sentry-moments-row" data-i="${i}">
        <i style="background:${k.color}"></i><span class="sentry-moments-kind">${esc(k.label)}</span>
        <span class="sentry-moments-value">${esc(value(m))}</span>
        <span class="sentry-moments-time">${esc(at ? clock(at) : m.clip)}</span></button>`;
    }).join('');
  }

  list.addEventListener('click', (e) => {
    const b = e.target.closest('[data-i]');
    if (b) onPick(items[Number(b.dataset.i)]);
  });

  return {
    async load(vehicleId, day) {
      const mine = ++seq;
      if (!vehicleId || !day) { list.innerHTML = ''; return; }
      list.innerHTML = '<p class="sentry-moments-note">Looking…</p>';
      try {
        const r = await fetch(`/api/vehicles/${encodeURIComponent(vehicleId)}/moments?date=${encodeURIComponent(day)}`, { credentials: 'same-origin' });
        const data = await r.json();
        if (mine !== seq) return;
        if (!r.ok) throw new Error(data.error || 'Could not load moments.');
        draw(data);
      } catch (err) {
        if (mine === seq) list.innerHTML = `<p class="sentry-moments-note">${esc(err.message)}</p>`;
      }
    },
    /** Draw again (the speed unit changed). */
    refresh() { draw(last); },
    destroy() { seq++; list.remove(); }
  };
}
