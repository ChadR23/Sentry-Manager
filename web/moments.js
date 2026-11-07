// Find moments: the day's hard braking, swerves and top speeds, from the
// speed index (GET /api/vehicles/:id/moments). Each interface's Viewer puts
// the list in its own page; picking one plays it there.
//
//   const moments = createMoments(el, {
//     clock: (hms) => …,           // "HH-MM-SS" in the pack's clock format
//     speedUnit: () => 'mph',      // or 'kmh'
//     onPick: ({ clip, second, path }) => …,   // play this moment of the day shown
//     now: () => ({ clip, second }),          // where the playhead is (Star this moment)
//     openAt: ({ vehicle, day, clip, second }) => …  // a starred moment of another day
//   });
//
// Above the list, the day in numbers (distance, time driving, top speed);
// below it, Star this moment (with a note; it also protects the recording)
// and the vehicle's starred moments from every day (/api/stars).
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
.sentry-moments .sentry-moments-row{all:unset;box-sizing:border-box;display:grid;width:100%;grid-template-columns:10px 1fr auto;gap:2px 10px;align-items:center;
  padding:7px 8px;border-radius:6px;cursor:pointer}
.sentry-moments-row:hover,.sentry-moments-row:focus-visible{background:rgba(127,127,127,.14)}
.sentry-moments-row i{width:10px;height:10px;border-radius:50%;grid-row:span 2}
.sentry-moments-kind{font-weight:600}
.sentry-moments-value{font-variant-numeric:tabular-nums;font-weight:600;text-align:right}
.sentry-moments-time{grid-column:2 / span 2;opacity:.7;font-variant-numeric:tabular-nums}
.sentry-moments-note{opacity:.7;margin:4px 0;line-height:1.4}
.sentry-moments-sum{display:flex;flex-wrap:wrap;gap:4px 14px;margin:2px 0 6px;font-variant-numeric:tabular-nums}
.sentry-moments-sum b{font-weight:700}
.sentry-moments-h{margin:12px 0 2px;font-size:12px;font-weight:700;letter-spacing:.04em;text-transform:uppercase;opacity:.75}
.sentry-moments-starbtn,.sentry-moments-form button{all:unset;box-sizing:border-box;cursor:pointer;padding:6px 10px;border-radius:6px;
  border:1px solid rgba(127,127,127,.4);font-weight:600;text-align:center}
.sentry-moments-starbtn:hover,.sentry-moments-form button:hover{background:rgba(127,127,127,.14)}
.sentry-moments-starbtn:focus-visible,.sentry-moments-form button:focus-visible{outline:2px solid currentColor}
.sentry-moments-form{display:flex;gap:6px;flex-wrap:wrap;margin-top:6px}
.sentry-moments-form input{flex:1 1 140px;min-width:0;padding:6px 8px;border-radius:6px;border:1px solid rgba(127,127,127,.4);background:transparent;color:inherit;font:inherit}
.sentry-moments-starred{display:grid;grid-template-columns:1fr auto;align-items:center}
.sentry-moments .sentry-moments-starred .sentry-moments-row{grid-template-columns:10px 1fr}
.sentry-moments-del{all:unset;cursor:pointer;padding:4px 8px;border-radius:6px;opacity:.6;font-size:16px;line-height:1}
.sentry-moments-del:hover,.sentry-moments-del:focus-visible{opacity:1;background:rgba(127,127,127,.14)}
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

export function createMoments(container, { clock = defaultClock, speedUnit = () => 'mph', onPick = () => {}, now = null, openAt = null } = {}) {
  addCss();
  const root = document.createElement('div');
  root.className = 'sentry-moments';
  root.innerHTML = `<div class="sentry-moments-sum" hidden></div><div class="sentry-moments-list"></div>
    ${now ? `<div class="sentry-moments-star"><button type="button" class="sentry-moments-starbtn">★ Star this moment</button>
      <form class="sentry-moments-form" hidden><input type="text" maxlength="200" placeholder="A note (optional): pothole, near miss…" aria-label="Note for this moment">
      <button type="submit">Save</button><button type="button" data-cancel>Cancel</button></form></div>` : ''}
    <p class="sentry-moments-h" hidden>Starred</p><div class="sentry-moments-starlist"></div>`;
  container.appendChild(root);
  const sumEl = root.querySelector('.sentry-moments-sum');
  const list = root.querySelector('.sentry-moments-list');
  const starHead = root.querySelector('.sentry-moments-h');
  const starList = root.querySelector('.sentry-moments-starlist');
  const starBtn = root.querySelector('.sentry-moments-starbtn');
  const form = root.querySelector('.sentry-moments-form');
  let items = [];
  let stars = [];
  let last = { moments: [] };
  let seq = 0;
  let vehicle = null;
  let shownDay = null;

  const speed = (mps) => (speedUnit() === 'kmh' ? `${Math.round(mps * 3.6)} km/h` : `${Math.round(mps * 2.23694)} mph`);
  const value = (m) => (m.kind === 'speed' ? speed(m.value) : `${(m.value / 9.81).toFixed(2)} g`);
  const distance = (m) => (speedUnit() === 'kmh' ? `${(m / 1000).toFixed(m < 10000 ? 1 : 0)} km` : `${(m / 1609.344).toFixed(m < 16093 ? 1 : 0)} mi`);
  const duration = (sec) => (sec < 3600 ? `${Math.max(1, Math.round(sec / 60))} min` : `${Math.floor(sec / 3600)} h ${Math.round((sec % 3600) / 60)} min`);
  const dayText = (d) => { try { return new Date(`${d}T12:00:00`).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' }); } catch { return d; } };
  const timeOf = (x) => { const at = timeAfter(x.clip, x.second); return at ? clock(at) : x.clip; };
  const send = (method, url, body) => fetch(url, { method, credentials: 'same-origin', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'sentry-six-manager' }, body: body ? JSON.stringify(body) : undefined })
    .then(async (r) => { const d = await r.json().catch(() => ({})); if (!r.ok) throw new Error(d.error || 'That did not work.'); return d; });

  function draw(data) {
    last = data;
    items = data.moments || [];
    const sum = data.summary;
    sumEl.hidden = !(sum && sum.distance > 0);
    if (sum && sum.distance > 0) sumEl.innerHTML = `<span><b>${esc(distance(sum.distance))}</b> driven</span><span><b>${esc(duration(sum.driving))}</b> moving</span><span>top <b>${esc(speed(sum.top))}</b></span>`;
    const left = (data.clips || 0) - (data.indexed || 0);
    const pending = left > 0 ? `<p class="sentry-moments-note">Still reading ${left} of ${data.clips} clips in the background; more may appear.</p>` : '';
    if (!items.length) {
      list.innerHTML = `${pending}<p class="sentry-moments-note">${data.clips ? 'No hard braking or swerves this day.' : 'No clips with driving data this day.'}</p>`;
    } else {
      list.innerHTML = pending + items.map((m, i) => {
        const k = KIND[m.kind] || { label: m.kind, color: '#999' };
        return `<button type="button" class="sentry-moments-row" data-i="${i}">
          <i style="background:${k.color}"></i><span class="sentry-moments-kind">${esc(k.label)}</span>
          <span class="sentry-moments-value">${esc(value(m))}</span>
          <span class="sentry-moments-time">${esc(timeOf(m))}</span></button>`;
      }).join('');
    }
  }

  function drawStars() {
    starHead.hidden = !stars.length;
    starList.innerHTML = stars.map((x, i) => `<div class="sentry-moments-starred">
      <button type="button" class="sentry-moments-row" data-star="${i}"><i style="background:#ffd34a"></i>
        <span class="sentry-moments-kind">${esc(x.note || 'Starred moment')}</span>
        <span class="sentry-moments-time">${esc(x.day === shownDay ? '' : `${dayText(x.day)} · `)}${esc(timeOf(x))}</span></button>
      <button type="button" class="sentry-moments-del" data-unstar="${esc(x.id)}" aria-label="Remove the star from ${esc(x.note || 'this moment')}" title="Remove the star">×</button></div>`).join('');
  }

  async function loadStars() {
    if (!vehicle) return;
    try {
      const r = await fetch(`/api/stars?vehicle=${encodeURIComponent(vehicle)}`, { credentials: 'same-origin' });
      stars = r.ok ? (await r.json()).stars || [] : [];
    } catch { stars = []; }
    drawStars();
  }

  root.addEventListener('click', async (e) => {
    const m = e.target.closest('[data-i]');
    if (m) { onPick(items[Number(m.dataset.i)]); return; }
    const st = e.target.closest('[data-star]');
    if (st) {
      const x = stars[Number(st.dataset.star)];
      if (x.day === shownDay) onPick(x);
      else openAt?.(x);
      return;
    }
    const un = e.target.closest('[data-unstar]');
    if (un) {
      try { await send('DELETE', `/api/stars/${encodeURIComponent(un.dataset.unstar)}`); } catch { /* shown again below */ }
      loadStars();
      return;
    }
    if (e.target.closest('[data-cancel]')) { form.hidden = true; starBtn.hidden = false; }
  });
  starBtn?.addEventListener('click', () => {
    if (!now?.()) return;
    starBtn.hidden = true;
    form.hidden = false;
    form.querySelector('input').value = '';
    form.querySelector('input').focus();
  });
  form?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const at = now?.();
    if (!at || !vehicle) return;
    const save = form.querySelector('[type=submit]');
    save.disabled = true;
    try {
      await send('POST', '/api/stars', { vehicle, clip: at.clip, second: Math.floor(at.second), note: form.querySelector('input').value });
      form.hidden = true;
      starBtn.hidden = false;
      starBtn.textContent = '★ Starred: its recording is protected';
      setTimeout(() => { starBtn.textContent = '★ Star this moment'; }, 2500);
      loadStars();
    } catch (err) {
      form.querySelector('input').setCustomValidity(err.message);
      form.querySelector('input').reportValidity();
      setTimeout(() => form.querySelector('input').setCustomValidity(''), 3000);
    } finally {
      save.disabled = false;
    }
  });

  return {
    async load(vehicleId, day) {
      const mine = ++seq;
      vehicle = vehicleId || null;
      shownDay = day || null;
      if (!vehicleId || !day) { list.innerHTML = ''; return; }
      list.innerHTML = '<p class="sentry-moments-note">Looking…</p>';
      loadStars();
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
    refresh() { draw(last); drawStars(); },
    destroy() { seq++; root.remove(); }
  };
}
