// Settings > Places, the same in every interface: the saved places (Home,
// Work) that tag Sentry and Saved events "at Home" on the Footage page, with
// their radius; where the car parks most (from the events' own positions,
// worked out on the server), this device's location, or coordinates pasted
// from a maps app. Nothing here asks any service outside the server.
//
//   const p = createPlacesSettings(el, {
//     cls: { btn, primary, danger, input, muted },  // the interface's own classes
//     toast: (message, bad) => …,
//     confirm: ({ title, body, ok }) => Promise<boolean>
//   });
//   p.destroy();

const STYLE = `
.sentry-pl.pl-ro [data-add],.sentry-pl.pl-ro button{display:none!important}
.sentry-pl{display:flex;flex-direction:column;gap:18px;font-size:14px;line-height:1.45}
.sentry-pl h3{margin:0 0 6px;font-size:15px}
.sentry-pl p{margin:0}
.sentry-pl ul{list-style:none;margin:0;padding:0;display:flex;flex-direction:column}
.sentry-pl li{display:flex;flex-wrap:wrap;gap:8px 12px;align-items:center;padding:10px 0;border-top:1px solid rgba(127,127,127,.22)}
.sentry-pl li:first-child{border-top:0}
.sentry-pl .pl-grow{flex:1 1 220px;min-width:0}
.sentry-pl .pl-acts{display:flex;flex-wrap:wrap;gap:6px}
.sentry-pl .pl-mono{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12.5px;overflow-wrap:anywhere}
.sentry-pl .pl-dim{opacity:.72}
.sentry-pl .pl-tag{display:inline-block;font-size:11px;font-weight:700;padding:1px 8px;border-radius:999px;background:rgba(255,211,74,.24);white-space:nowrap;vertical-align:1px}
.sentry-pl .pl-pin{width:10px;height:10px;border-radius:3px;background:#ffd34a;border:2px solid #fff;box-shadow:0 0 0 1px rgba(0,0,0,.25);flex:none}
.sentry-pl .pl-edit,.sentry-pl .pl-add{display:flex;flex-wrap:wrap;gap:10px;align-items:flex-end;width:100%}
.sentry-pl .pl-edit[hidden],.sentry-pl .pl-add [hidden]{display:none}
.sentry-pl label.pl-f{display:flex;flex-direction:column;gap:4px;font-size:13px;font-weight:600;flex:1 1 160px;min-width:0}
.sentry-pl label.pl-f.pl-r{flex:0 1 120px}
.sentry-pl label.pl-f input{width:100%;box-sizing:border-box;min-width:0}
.sentry-pl .pl-note{font-size:12.5px}
.sentry-pl .pl-err{color:#e5484d}
`;
const esc = (t) => String(t ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const H = { 'Content-Type': 'application/json', 'X-Requested-With': 'sentry-six-manager' };
const MIN_R = 50;
const MAX_R = 2000;

/**
 * Coordinates typed or pasted as maps apps copy them, as { lat, lon }, or
 * null: "41.8781, -87.6298", "41.8781° N, 87.6298° W", "N 41.8781 W 87.6298",
 * 41°52'41.2"N 87°37'47.3"W, and links with @lat,lon, q=lat,lon or ll=lat,lon.
 */
export function parseCoords(text) {
  let s = String(text ?? '').trim();
  if (!s || s.length > 2000) return null;
  const inLink = s.match(/[@=](-?\d{1,3}(?:\.\d+)?),\s*(-?\d{1,3}(?:\.\d+)?)/);
  if (/^[a-z]+:\/\//i.test(s) || /[?&](q|ll|query|sll|daddr)=/.test(s)) return inLink ? check(Number(inLink[1]), Number(inLink[2])) : null;
  s = s.replace(/[′’‘`´]/g, "'").replace(/[″“”]/g, '"').replace(/''/g, '"').replace(/º|˚/g, '°').replace(/\s+/g, ' ').toUpperCase();
  // "41,8781; -87,6298": decimal commas when a semicolon parts the two
  if (s.includes(';')) s = s.replace(/(\d),(\d)/g, '$1.$2').replace(';', ',');
  const num = String.raw`(-|\+)?\s*(\d{1,3}(?:\.\d+)?)\s*(?:°\s*(?:(\d{1,2}(?:\.\d+)?)\s*'\s*(?:(\d{1,2}(?:\.\d+)?)\s*")?)?)?`;
  const lead = /^[NSEW]/.test(s);
  const re = new RegExp(lead ? String.raw`([NSEW])\s*${num}` : String.raw`${num}\s*([NSEW])?`, 'g');
  const parts = [];
  let rest = s;
  for (const m of s.matchAll(re)) {
    const [hemi, sign, d, mi, se] = lead ? [m[1], m[2], m[3], m[4], m[5]] : [m[5], m[1], m[2], m[3], m[4]];
    if (mi !== undefined && !/^\d+$/.test(d)) return null; // 41.5°30' is not a coordinate
    if (Number(mi ?? 0) >= 60 || Number(se ?? 0) >= 60) return null;
    let v = Number(d) + Number(mi ?? 0) / 60 + Number(se ?? 0) / 3600;
    if (sign === '-') v = -v;
    if (hemi === 'S' || hemi === 'W') {
      if (sign === '-') return null; // "-41 S" says it twice
      v = -v;
    }
    parts.push({ v, axis: hemi === 'N' || hemi === 'S' ? 'lat' : hemi === 'E' || hemi === 'W' ? 'lon' : null });
    rest = rest.replace(m[0], ' ');
  }
  // nothing else may be in there but the separator
  if (parts.length !== 2 || /[^\s,/]/.test(rest)) return null;
  const [a, b] = parts;
  if (a.axis && b.axis) {
    if (a.axis === b.axis) return null;
    return a.axis === 'lat' ? check(a.v, b.v) : check(b.v, a.v);
  }
  if (a.axis === 'lon' || b.axis === 'lat') return null;
  return check(a.v, b.v);
}
function check(lat, lon) {
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  if (lat === 0 && lon === 0) return null;
  return { lat: Math.round(lat * 1e6) / 1e6, lon: Math.round(lon * 1e6) / 1e6 };
}

// a form's field (form.name is the form's own name, not its Name field)
const fld = (form, name) => form.querySelector(`[name="${name}"]`);
const fix6 = (n) => (Number.isFinite(n) ? n.toFixed(6) : '?');
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
function dayText(at) {
  if (!at) return '';
  const d = new Date(String(at).replace(' ', 'T'));
  if (Number.isNaN(d.getTime())) return String(at).slice(0, 10);
  return d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', year: d.getFullYear() === new Date().getFullYear() ? undefined : 'numeric' });
}

export function createPlacesSettings(el, { cls = {}, toast = () => {}, confirm = async () => window.confirm('Remove this place?') } = {}) {
  if (!document.getElementById('sentry-pl-css')) {
    const style = document.createElement('style');
    style.id = 'sentry-pl-css';
    style.textContent = STYLE;
    document.head.appendChild(style);
  }
  const c = { btn: 'btn', primary: 'btn primary', danger: 'btn danger', input: 'input', muted: 'muted', ...cls };
  const secure = typeof window !== 'undefined' && window.isSecureContext && 'geolocation' in navigator;
  el.innerHTML = `<div class="sentry-pl">
    <p>Sentry and Saved events within a place’s radius get a tag like <span class="pl-tag">at Home</span> on the Footage page. Recent clips have no position from Tesla.</p>
    <section><h3>Saved places</h3><ul data-places><li class="pl-dim">Loading…</li></ul></section>
    <section><h3>Where the car parks most</h3>
      <p class="${c.muted} pl-note">From where the car was in its Sentry and Saved events of the last 90 days. Spots a saved place covers already are left out.</p>
      <ul data-sugg><li class="pl-dim">Looking through the events…</li></ul></section>
    <section><h3>Add a place yourself</h3>
      <form class="pl-add" data-add novalidate>
        <label class="pl-f">Name<input class="${c.input}" name="name" maxlength="60" placeholder="Home" autocomplete="off" required></label>
        <label class="pl-f" style="flex-basis:260px">Coordinates<input class="${c.input} pl-mono" name="coords" placeholder="41.8781, -87.6298" autocomplete="off" autocapitalize="none" spellcheck="false" inputmode="text"></label>
        <label class="pl-f pl-r">Radius (m)<input class="${c.input}" name="radius" type="number" min="${MIN_R}" max="${MAX_R}" step="10" value="200" inputmode="numeric"></label>
        <div class="pl-acts"><button class="${c.btn}" type="button" data-here${secure ? '' : ' disabled'}>Use this device’s location</button><button class="${c.primary}" type="submit">Save place</button></div>
        <p class="${c.muted} pl-note" style="width:100%">Paste coordinates as a maps app copies them, like <span class="pl-mono">41.8781, -87.6298</span> or <span class="pl-mono">41.8781° N, 87.6298° W</span>. ${secure ? 'Or stand at the place and use this device’s location.' : 'This device’s location needs the manager opened over HTTPS (the browser keeps it from plain HTTP pages), or a browser that shares it.'}</p>
        <p class="pl-note pl-err" data-adderr role="alert" hidden></p>
      </form></section>
  </div>`;
  const $ = (s) => el.querySelector(s);
  // places are for admins: a watch-only account sees them, without the buttons
  fetch('/api/auth/me', { credentials: 'same-origin' }).then((r) => (r.ok ? r.json() : null)).then((m) => {
    if (m?.role !== 'viewer') return;
    const root = el.querySelector('.sentry-pl');
    root?.classList.add('pl-ro');
    root?.insertAdjacentHTML('afterbegin', `<p class="${c.muted} pl-note">Only an admin can add or change places.</p>`);
  }).catch(() => {});
  let alive = true;
  let places = [];
  let counts = null;
  let sugg = null;
  let suggErr = '';

  async function call(method, url, body) {
    const r = await fetch(url, { method, credentials: 'same-origin', headers: H, body: body === undefined ? undefined : JSON.stringify(body) });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error || `The server said ${r.status}.`);
    return data;
  }
  const hasName = (n) => places.some((p) => p.name.trim().toLowerCase() === n.toLowerCase());

  function drawPlaces() {
    $('[data-places]').innerHTML = places.map((p) => {
      const r = Number.isFinite(p.radius) ? p.radius : 200;
      const n = counts?.[p.id];
      return `<li data-place="${esc(p.id)}"><i class="pl-pin" aria-hidden="true"></i>
        <span class="pl-grow"><b>${esc(p.name)}</b>${Number.isFinite(n) ? ` <span class="pl-tag">${esc(plural(n, 'event'))}</span>` : ''}<br><span class="pl-mono pl-dim">${fix6(p.lat)}, ${fix6(p.lon)} · ${r} m</span></span>
        <span class="pl-acts"><button class="${c.btn}" type="button" data-edit>Edit</button><button class="${c.danger}" type="button" data-del>Delete</button></span>
        <form class="pl-edit" data-editform hidden novalidate>
          <label class="pl-f">Name<input class="${c.input}" name="name" maxlength="60" value="${esc(p.name)}" required></label>
          <label class="pl-f pl-r">Radius (m)<input class="${c.input}" name="radius" type="number" min="${MIN_R}" max="${MAX_R}" step="10" value="${r}" inputmode="numeric"></label>
          <span class="pl-acts"><button class="${c.btn}" type="button" data-cancel>Cancel</button><button class="${c.primary}" type="submit">Save</button></span>
        </form></li>`;
    }).join('') || `<li class="pl-dim">No saved places yet. Save one from the suggestions below, or add one yourself.</li>`;
  }
  function drawSugg() {
    const box = $('[data-sugg]');
    if (suggErr) { box.innerHTML = `<li class="pl-err">${esc(suggErr)}</li>`; return; }
    if (!sugg) return;
    const list = sugg.suggestions || [];
    box.innerHTML = list.map((s, i) => {
      const where = [s.street, s.city].filter(Boolean).join(', ') || 'A spot without a street name';
      const btns = [!hasName('Home') && `<button class="${c.btn}" type="button" data-save="Home">Save as Home</button>`, !hasName('Work') && `<button class="${c.btn}" type="button" data-save="Work">Save as Work</button>`, `<button class="${c.btn}" type="button" data-saveas>Save as…</button>`].filter(Boolean).join('');
      return `<li data-sugg-i="${i}"><span class="pl-grow"><b>${esc(where)}</b><br><span class="pl-dim">${esc(plural(s.count, 'event'))}${s.last ? ` · last ${esc(dayText(s.last))}` : ''}${s.vehicles?.length > 1 ? ` · ${esc(s.vehicles.join(', '))}` : ''}</span><br><span class="pl-mono pl-dim">${fix6(s.lat)}, ${fix6(s.lon)}</span></span>
        <span class="pl-acts">${btns}</span>
        <form class="pl-edit" data-nameform hidden novalidate><label class="pl-f">Name<input class="${c.input}" name="name" maxlength="60" placeholder="Gym, Mum’s" required></label>
          <span class="pl-acts"><button class="${c.btn}" type="button" data-cancel>Cancel</button><button class="${c.primary}" type="submit">Save</button></span></form></li>`;
    }).join('') || `<li class="pl-dim">${sugg.withPosition ? 'Nowhere yet: no spot has two or more events outside the saved places.' : sugg.events ? 'None of the recent events has a position (event.json est_lat / est_lon).' : 'No Sentry or Saved events in the last 90 days.'}</li>`;
  }
  async function loadPlaces() {
    try { places = (await call('GET', '/api/places')).places || []; } catch (err) { if (alive) $('[data-places]').innerHTML = `<li class="pl-err">${esc(err.message)}</li>`; return; }
    if (alive) drawPlaces();
  }
  async function loadSugg() {
    try {
      sugg = await call('GET', '/api/places/suggestions');
      counts = sugg.counts || null;
      suggErr = '';
    } catch (err) { suggErr = err.message; }
    if (!alive) return;
    drawSugg();
    drawPlaces();
  }
  const reload = async () => { await loadPlaces(); if (alive) await loadSugg(); };

  async function add(name, lat, lon, radius) {
    await call('POST', '/api/places', { name, lat, lon, ...(radius !== undefined ? { radius } : {}) });
    toast(`Saved ${name}. Events there get the tag “at ${name}”.`, false);
    await reload();
  }
  const radiusOk = (v) => Number.isFinite(v) && v >= MIN_R && v <= MAX_R;

  el.addEventListener('click', async (e) => {
    const b = e.target.closest('button');
    if (!b || !el.contains(b)) return;
    const li = b.closest('li');
    if (b.hasAttribute('data-edit')) {
      const f = li.querySelector('[data-editform]');
      f.hidden = !f.hidden;
      if (!f.hidden) f.querySelector('input').focus();
    } else if (b.hasAttribute('data-cancel')) {
      b.closest('form').hidden = true;
    } else if (b.hasAttribute('data-del')) {
      const p = places.find((x) => x.id === li.dataset.place);
      if (!p || !(await confirm({ title: `Delete ${p.name}?`, body: `<p>Events there lose the tag “at ${esc(p.name)}”. No footage is deleted.</p>`, ok: 'Delete place' }))) return;
      try { await call('DELETE', `/api/places/${encodeURIComponent(p.id)}`); toast(`Deleted ${p.name}.`, false); await reload(); } catch (err) { toast(err.message, true); }
    } else if (b.dataset.save) {
      const s = sugg?.suggestions?.[Number(li.dataset.suggI)];
      if (!s) return;
      b.disabled = true;
      try { await add(b.dataset.save, s.lat, s.lon); } catch (err) { b.disabled = false; toast(err.message, true); }
    } else if (b.hasAttribute('data-saveas')) {
      const f = li.querySelector('[data-nameform]');
      f.hidden = !f.hidden;
      if (!f.hidden) f.querySelector('input').focus();
    } else if (b.hasAttribute('data-here')) {
      const form = $('[data-add]');
      b.disabled = true;
      const was = b.textContent;
      b.textContent = 'Finding this device…';
      navigator.geolocation.getCurrentPosition((pos) => {
        b.disabled = false;
        b.textContent = was;
        fld(form, 'coords').value = `${pos.coords.latitude.toFixed(6)}, ${pos.coords.longitude.toFixed(6)}`;
        const acc = Math.round(pos.coords.accuracy || 0);
        toast(`Found this device${acc ? ` (to within ${acc} m)` : ''}. Name the place and save it.`, false);
        (fld(form, 'name').value ? form.querySelector('[type=submit]') : fld(form, 'name')).focus();
      }, (err) => {
        b.disabled = false;
        b.textContent = was;
        toast(err.code === 1 ? 'The browser was not allowed to share this device’s location.' : 'This device’s location is not available right now.', true);
      }, { enableHighAccuracy: true, timeout: 20000, maximumAge: 60000 });
    }
  });
  el.addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target;
    const go = f.querySelector('[type=submit]');
    try {
      if (f.matches('[data-add]')) {
        const err = $('[data-adderr]');
        const fail = (m) => { err.textContent = m; err.hidden = false; };
        err.hidden = true;
        const name = fld(f, 'name').value.trim();
        const at = parseCoords(fld(f, 'coords').value);
        const radius = Number(fld(f, 'radius').value);
        if (!name) return fail('Give the place a name, like Home or Work.');
        if (!at) return fail(fld(f, 'coords').value.trim() ? 'Those are not coordinates the manager can read. Try 41.8781, -87.6298.' : 'Paste the coordinates, or use this device’s location.');
        if (!radiusOk(radius)) return fail(`The radius is ${MIN_R} to ${MAX_R} m.`);
        go.disabled = true;
        await add(name, at.lat, at.lon, Math.round(radius));
        f.reset();
      } else if (f.matches('[data-editform]')) {
        const id = f.closest('li').dataset.place;
        const radius = Number(fld(f, 'radius').value);
        if (!fld(f, 'name').value.trim()) return toast('Give the place a name.', true);
        if (!radiusOk(radius)) return toast(`The radius is ${MIN_R} to ${MAX_R} m.`, true);
        go.disabled = true;
        await call('PATCH', `/api/places/${encodeURIComponent(id)}`, { name: fld(f, 'name').value, radius: Math.round(radius) });
        toast('Saved.', false);
        await reload();
      } else if (f.matches('[data-nameform]')) {
        const s = sugg?.suggestions?.[Number(f.closest('li').dataset.suggI)];
        const name = fld(f, 'name').value.trim();
        if (!s) return;
        if (!name) return toast('Give the place a name.', true);
        go.disabled = true;
        await add(name, s.lat, s.lon);
      }
    } catch (err) {
      toast(err.message, true);
    } finally {
      if (go && document.contains(go)) go.disabled = false;
    }
  });
  reload();
  return { destroy() { alive = false; el.innerHTML = ''; }, reload };
}
