// Footage: a calendar of days with pictures. Tap a day to see what the car
// recorded, play it, keep it safe (protect) or move it to the Recycle Bin.

import { api, esc, enc, icon, bytes, plural, dayTitle, dayShort, niceTime, CATEGORY, CODEC, humanize, chip, emptyState, confirmDialog, toast, fail, busy, ago, store } from '../core.js';
import { state, vehicle, setVehicle, vehiclePicker, loadVehicles } from '../state.js';
import { go } from '../app.js';

export const thumbUrl = (vid, rid) => `/api/vehicles/${enc(vid)}/recordings/${enc(rid)}/thumbnail`;
const DAYS_PAGE = 30;
const CATS = [['all', 'Everything'], ['Recent', 'Drives'], ['Sentry', 'Sentry'], ['Saved', 'Saved'], ['Other', 'Other']];

// a live update waits while something is being typed or picked
const typing = () => Boolean(document.activeElement?.matches?.('input:not([type=checkbox]), select, textarea') || document.querySelector('dialog[open]'));
const view$ = { category: 'all', onlyProtected: false, month: null };

function catChips(d) {
  return Object.entries(d.byCategory || {}).map(([c, n]) => chip(plural(n, (CATEGORY[c] || CATEGORY.Other).word, (CATEGORY[c] || CATEGORY.Other).many), (CATEGORY[c] || CATEGORY.Other).tone)).join('');
}
function encodedChip(e) {
  if (!e || !e.clips || !e.encoded) return '';
  return chip(e.encoded === e.clips ? `Smaller format${e.codecs?.length ? ` (${e.codecs.map((c) => CODEC[c] || c).join(' + ')})` : ''}` : `${e.encoded} of ${e.clips} clips converted`, 'teal', 'sparkle');
}

/** Moves recordings to the Recycle Bin, offering Undo (restore) after. */
export async function moveToBin(v, recs, { ask = true } = {}) {
  if (!recs.length) return false;
  const total = recs.reduce((n, r) => n + (r.bytes || 0), 0);
  if (ask && !(await confirmDialog({
    title: recs.length === 1 ? 'Move this to the Recycle Bin?' : `Move ${plural(recs.length, 'recording')} to the Recycle Bin?`,
    body: `<p>${bytes(total)} goes to the Recycle Bin on the same storage. Nothing is deleted: you can put it back any time.</p>${recs.some((r) => r.protected) ? '<p class="muted">Protected recordings stay where they are.</p>' : ''}`,
    ok: 'Move to Recycle Bin'
  }))) return false;
  const since = Date.now() - 2000;
  try {
    const out = await api(`/api/vehicles/${enc(v.id)}/trash`, { body: { ids: recs.map((r) => r.id) } });
    const skipped = out.skipped?.length ? ` ${plural(out.skipped.length, 'recording')} stayed (${[...new Set(out.skipped.map((s) => (s.reason === 'protected' ? 'protected' : s.reason === 'converting' ? 'being converted' : s.reason)))].join(', ')}).` : '';
    if (!out.moved?.length) {
      toast(`Nothing moved.${skipped}`, { kind: 'bad' });
      return false;
    }
    const labels = new Set(recs.filter((r) => out.moved.includes(r.id)).map((r) => `${r.category} ${r.start || ''}`.trim()));
    toast(`${plural(out.moved.length, 'recording')} moved to the Recycle Bin (${bytes(out.bytes)}).${skipped}`, {
      kind: 'good',
      action: {
        label: 'Undo',
        run: async () => {
          try {
            const { items } = await api(`/api/bin?vehicle=${enc(v.id)}`);
            const mine = items.filter((i) => i.trashedAt >= since && labels.has(i.label));
            for (const i of mine) await api(`/api/bin/${enc(i.id)}/restore`, { body: {} });
            toast(mine.length ? 'Put back where it was.' : 'Couldn’t find it in the Recycle Bin any more.', { kind: mine.length ? 'good' : 'bad' });
            loadVehicles().catch(() => {});
          } catch (err) { fail(err); }
        }
      }
    });
    loadVehicles().catch(() => {});
    return true;
  } catch (err) {
    fail(err);
    return false;
  }
}

export async function setProtected(v, ids, on) {
  try {
    await api(`/api/vehicles/${enc(v.id)}/protect`, { body: { ids, protected: on } });
    toast(on ? 'Protected. Cleanup rules and the Recycle Bin will leave it alone.' : 'Protection removed.', { kind: 'good' });
    return true;
  } catch (err) {
    fail(err);
    return false;
  }
}

async function trashDays(v, day, through) {
  const body = { day, through, category: view$.category };
  let preview;
  try {
    preview = await api(`/api/vehicles/${enc(v.id)}/trash-days`, { body: { ...body, preview: true } });
  } catch (err) { return fail(err); }
  if (!preview.recordings) {
    toast(preview.protected ? 'Everything there is protected, so nothing needs moving.' : 'There’s nothing to move.');
    return false;
  }
  const what = through ? `${esc(dayTitle(day))} and every day before it` : esc(dayTitle(day));
  const ok = await confirmDialog({
    title: through ? 'Clear out this day and older?' : 'Move this whole day to the Recycle Bin?',
    body: `<p>${plural(preview.recordings, 'recording')} from ${what}${view$.category !== 'all' ? ` (${esc(CATS.find((c) => c[0] === view$.category)?.[1] || '')} only)` : ''}, ${bytes(preview.bytes)}${through && preview.days > 1 ? ` across ${plural(preview.days, 'day')}` : ''}, will move to the Recycle Bin.</p>
      <p class="muted">You can restore it from there until you empty the Recycle Bin.${preview.protected ? ` ${plural(preview.protected, 'protected recording')} will stay.` : ''}</p>`,
    ok: 'Move to Recycle Bin', danger: through
  });
  if (!ok) return false;
  try {
    const out = await api(`/api/vehicles/${enc(v.id)}/trash-days`, { body });
    toast(`Moving ${plural(out.recordings, 'recording')} (${bytes(out.bytes)}) to the Recycle Bin. Activity shows the progress.`, { kind: 'good', action: { label: 'Open Recycle Bin', run: () => go('#/bin') } });
    return true;
  } catch (err) { fail(err); return false; }
}

// ---------- the calendar ----------
function calendar(dates, month, selected) {
  const have = new Set(dates);
  const [y, m] = month.split('-').map(Number);
  const first = new Date(y, m - 1, 1);
  const startDow = (first.getDay() + 6) % 7; // Monday first
  const daysIn = new Date(y, m, 0).getDate();
  const today = new Date();
  const todayKey = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
  const cells = [];
  for (let i = 0; i < startDow; i++) cells.push('<span></span>');
  for (let d = 1; d <= daysIn; d++) {
    const key = `${month}-${String(d).padStart(2, '0')}`;
    const cls = ['cal-day', have.has(key) ? 'has' : '', key === todayKey ? 'today' : '', key === selected ? 'sel' : ''].filter(Boolean).join(' ');
    cells.push(have.has(key)
      ? `<button type="button" class="${cls}" data-day="${key}" aria-label="${esc(dayTitle(key))}, has footage">${d}</button>`
      : `<span class="${cls}" aria-hidden="true">${d}</span>`);
  }
  const months = [...new Set(dates.map((d) => d.slice(0, 7)))].sort();
  const idx = months.indexOf(month);
  const label = first.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
  return `<div class="card cal" aria-label="Calendar of days with footage">
    <div class="cal-head"><button type="button" class="icon-btn" data-month="${esc(months[idx - 1] || '')}" aria-label="Earlier month"${idx > 0 ? '' : ' disabled'}>${icon('back')}</button>
      <b>${esc(label)}</b>
      <button type="button" class="icon-btn" data-month="${esc(months[idx + 1] || '')}" aria-label="Later month"${idx >= 0 && idx < months.length - 1 ? '' : ' disabled'}>${icon('next')}</button></div>
    <div class="cal-grid">${['M', 'T', 'W', 'T', 'F', 'S', 'S'].map((d) => `<span class="dow" aria-hidden="true">${d}</span>`).join('')}${cells.join('')}</div>
    <p class="cal-legend">Highlighted days have footage. Tap one to open it.</p>
  </div>`;
}

function dayCard(v, d) {
  return `<a class="card day-card" href="#/footage/${enc(d.day)}?vehicle=${enc(v.id)}">
    <div class="thumb">${d.thumbId ? `<img class="thumb-img" loading="lazy" alt="" src="${thumbUrl(v.id, d.thumbId)}">` : icon('film')}
      <span class="thumb-badge">${plural(d.recordings, 'recording')}</span><span class="play-over">${icon('playOutline')}</span></div>
    <div class="dc-body"><span class="dc-title">${esc(dayTitle(d.day, { weekday: 'long', month: 'short', day: 'numeric' }))}</span>
      <div class="row">${catChips(d)}${d.protected ? chip(`${d.protected} protected`, 'good', 'lock') : ''}${d.encodedRecordings ? chip(d.encodedRecordings === d.recordings ? 'Converted' : `${d.encodedRecordings}/${d.recordings} converted`, 'teal', 'sparkle') : ''}</div>
      <span class="dc-meta">${d.minutes} min of video · ${bytes(d.bytes)}</span></div></a>`;
}

function noVehicle(view) {
  view.innerHTML = `<div class="page"><div class="page-head"><div><h1>Footage</h1></div></div>${emptyState({ art: 'car', title: 'No vehicle yet', text: 'Add your Tesla and its footage shows up here, day by day.', action: '<a class="btn btn-primary" href="#/settings/add-vehicle">Add my vehicle</a>' })}</div>`;
}

export async function render(ctx) {
  const { view, params, query } = ctx;
  if (query.get('vehicle')) setVehicle(query.get('vehicle'));
  const v = vehicle();
  if (!v) return noVehicle(view);
  if (params[0] && /^\d{4}-\d{2}-\d{2}$/.test(params[0])) return renderDay(ctx, v, params[0]);
  return renderDays(ctx, v);
}

async function renderDays(ctx, v) {
  const { view } = ctx;
  let shown = DAYS_PAGE;
  const load = async () => {
    const q = new URLSearchParams({ category: view$.category, offset: '0', limit: String(Math.min(100, shown)) });
    const data = await api(`/api/vehicles/${enc(v.id)}/days?${q}`);
    // "protected only": the days that hold a protected recording
    if (view$.onlyProtected) data.days = data.days.filter((d) => d.protected > 0);
    return data;
  };
  let data = await load();
  if (!ctx.alive()) return;

  const draw = () => {
    const month = view$.month && data.dates.some((d) => d.startsWith(view$.month)) ? view$.month : (data.dates[0] || new Date().toISOString().slice(0, 10)).slice(0, 7);
    view$.month = month;
    const byMonth = new Map();
    for (const d of data.days) {
      const k = d.day.slice(0, 7);
      if (!byMonth.has(k)) byMonth.set(k, []);
      byMonth.get(k).push(d);
    }
    const lists = [...byMonth].map(([k, list]) => `<h2 class="month-label">${esc(new Date(`${k}-15T12:00:00`).toLocaleDateString(undefined, { month: 'long', year: 'numeric' }))}</h2>
      <div class="day-grid">${list.map((d) => dayCard(v, d)).join('')}</div>`).join('');
    const empty = data.error
      ? emptyState({ art: 'alert', title: 'Can’t read the footage right now', text: esc(data.error), action: '<button class="btn btn-primary" type="button" id="scan2">Try again</button>' })
      : data.scanning && !data.days.length ? emptyState({ art: 'film', title: 'Looking through the footage…', text: 'This can take a minute the first time.' })
        : emptyState({ art: 'film', title: view$.category === 'all' && !view$.onlyProtected ? 'No footage yet' : 'Nothing matches', text: view$.category === 'all' && !view$.onlyProtected ? `Once ${esc(v.name)} records something, it shows up here.` : 'Try another filter.', action: view$.category !== 'all' || view$.onlyProtected ? '<button class="btn btn-soft" type="button" id="reset-filter">Show everything</button>' : '' });
    view.innerHTML = `<div class="page">
      <div class="page-head"><div><h1>Footage</h1><p class="lede">${plural(data.total, 'day')} · ${plural(data.recordings, 'recording')}${data.scannedAt ? ` · up to date as of ${ago(data.scannedAt)}` : ''}${data.scanning ? ' · looking for new footage…' : ''}</p></div>
        <div class="head-actions">${vehiclePicker()}<button class="btn" type="button" id="scan">${icon('refresh')} <span>Refresh</span></button></div></div>
      <div class="toolbar"><div class="filter-chips" role="group" aria-label="Show">
        ${CATS.map(([k, label]) => `<button type="button" class="filter-chip" data-cat="${k}" aria-pressed="${view$.category === k}">${label}</button>`).join('')}
        <button type="button" class="filter-chip" id="only-prot" aria-pressed="${view$.onlyProtected}">${icon('lock')} Protected</button></div></div>
      <div class="footage-layout">
        <div>${data.dates.length ? calendar(data.dates, month, null) : ''}
          <div class="card" style="margin-top:16px"><h3>Save space</h3><p class="muted small" style="margin:6px 0 12px">Convert this car’s footage to a smaller format. Every clip stays watchable.</p><a class="btn btn-soft btn-block" href="#/encoder?vehicle=${enc(v.id)}">Review conversion</a></div></div>
        <div>${data.days.length ? lists : empty}
          ${data.total > data.days.length && !view$.onlyProtected && shown < 100 ? '<div class="row" style="justify-content:center"><button class="btn" type="button" id="older">Show older days</button></div>' : ''}
          ${data.total > 100 && shown >= 100 ? `<p class="muted small" style="text-align:center">Showing the newest 100 days. Use the calendar to jump to an older one.</p>` : ''}
        </div>
      </div></div>`;
    wire();
  };
  const refresh = async () => {
    try { data = await load(); } catch (err) { return fail(err); }
    if (ctx.alive()) draw();
    return undefined;
  };
  const wire = () => {
    view.querySelector('#vehicle-pick')?.addEventListener('change', (e) => { setVehicle(e.target.value); go(`#/footage?vehicle=${enc(e.target.value)}`); });
    view.querySelectorAll('[data-cat]').forEach((b) => { b.onclick = () => { view$.category = b.dataset.cat; refresh(); }; });
    view.querySelector('#only-prot').onclick = () => { view$.onlyProtected = !view$.onlyProtected; refresh(); };
    view.querySelector('#reset-filter')?.addEventListener('click', () => { view$.category = 'all'; view$.onlyProtected = false; refresh(); });
    const scan = (b) => busy(b, () => api(`/api/vehicles/${enc(v.id)}/scan`, { body: {} }).then(() => toast('Looking for new footage…'), fail));
    view.querySelector('#scan').onclick = (e) => scan(e.currentTarget);
    view.querySelector('#scan2')?.addEventListener('click', (e) => scan(e.currentTarget));
    view.querySelector('#older')?.addEventListener('click', () => { shown += DAYS_PAGE; refresh(); });
    view.querySelectorAll('[data-month]').forEach((b) => { b.onclick = () => { if (b.dataset.month) { view$.month = b.dataset.month; draw(); view.querySelector('.cal [data-month]')?.focus(); } }; });
    view.querySelectorAll('.cal [data-day]').forEach((b) => { b.onclick = () => go(`#/footage/${b.dataset.day}?vehicle=${enc(v.id)}`); });
  };
  draw();
  ctx.on('topics', (t) => { if (t.includes('inventory') && !typing()) refresh(); });
  ctx.on('vehicle', () => ctx.rerender());
}

// ---------- one day ----------
function recCard(v, r, selecting, selected) {
  const cat = CATEGORY[r.category] || CATEGORY.Other;
  const hasThumb = r.thumbRel || r.frontRel;
  const time = r.end && r.end !== r.start ? `${niceTime(r.start)} – ${niceTime(r.end)}` : niceTime(r.start);
  return `<article class="card rec-card${selected ? ' selected' : ''}" data-id="${esc(r.id)}">
    <button type="button" class="thumb" data-play aria-label="Play ${esc(cat.word)} at ${esc(time)}">${hasThumb ? `<img class="thumb-img" loading="lazy" alt="" src="${thumbUrl(v.id, r.id)}">` : icon('film')}<span class="thumb-badge">${r.minutes} min</span><span class="play-over">${icon('playOutline')}</span></button>
    <div class="rc-body">
      <div class="row-between"><span class="rc-time">${esc(time)}</span>
        ${selecting ? `<label class="rc-select"><input type="checkbox" data-select${selected ? ' checked' : ''}> Select</label>` : ''}</div>
      <div class="row">${chip(cat.word, cat.tone)}${r.protected ? chip('Protected', 'good', 'lock') : ''}${encodedChip(r.encoded)}</div>
      <p class="rc-sub">${r.eventAt ? `Event at ${esc(niceTime(r.eventAt))} · ` : ''}${plural(r.cameras.length, 'camera')} · ${bytes(r.bytes)}</p>
      <div class="rc-actions">
        <button class="btn btn-primary btn-sm" type="button" data-play>${icon('play')} Play</button>
        <button class="btn btn-sm" type="button" data-protect="${r.protected ? 'off' : 'on'}">${icon(r.protected ? 'unlock' : 'lock')} ${r.protected ? 'Unprotect' : 'Protect'}</button>
        ${r.protected ? '' : `<button class="btn btn-ghost btn-sm" type="button" data-trash>${icon('trash')} Move to Recycle Bin</button>`}
      </div>
      <details class="more" data-files><summary>More details</summary><div class="more-body"><p class="muted small">Loading…</p></div></details>
    </div></article>`;
}

async function filesBody(v, r) {
  const d = await api(`/api/vehicles/${enc(v.id)}/recordings/${enc(r.id)}`);
  const ev = d.event ? `<p class="small"><b>${esc(humanize(d.event.reason) || 'Event')}</b>${d.event.street || d.event.city ? ` · ${esc([d.event.street, d.event.city].filter(Boolean).join(', '))}` : ''}</p>` : '';
  const codecTag = (f) => (!('codec' in f) ? '<span></span>' : !f.codec ? '<span class="muted">checking</span>' : chip(CODEC[f.codec] || f.codec.toUpperCase(), f.codec === 'h264' ? 'grey' : 'teal'));
  return `${ev}<p class="small muted">Folder: <span class="mono">${esc(d.folder)}</span> · captured ${esc(d.startKey || d.day)} (car’s time)</p>
    <ul class="files">${d.files.map((f) => `<li><span title="${esc(f.rel)}">${esc(f.rel.split('/').pop())}</span>${codecTag(f)}<span class="muted">${bytes(f.size)}</span><a class="btn btn-ghost btn-sm" href="/api/media?path=${enc(f.path)}" download>${icon('download')}<span class="sr-only">Download ${esc(f.rel.split('/').pop())}</span></a></li>`).join('')}</ul>`;
}

async function renderDay(ctx, v, day) {
  const { view } = ctx;
  let recs = [];
  let selecting = false;
  const selected = new Set();
  const load = async () => {
    const q = new URLSearchParams({ date: day, category: view$.category, limit: '500' });
    recs = (await api(`/api/vehicles/${enc(v.id)}/recordings?${q}`)).recordings;
    for (const id of [...selected]) if (!recs.some((r) => r.id === id)) selected.delete(id);
  };
  await load();
  if (!ctx.alive()) return;
  const openFiles = new Set();

  const draw = () => {
    const sorted = [...recs].sort((a, b) => String(a.startKey).localeCompare(String(b.startKey)));
    const totalBytes = recs.reduce((n, r) => n + r.bytes, 0);
    const minutes = recs.reduce((n, r) => n + r.minutes, 0);
    view.innerHTML = `<div class="page">
      <a class="back-link" href="#/footage?vehicle=${enc(v.id)}">${icon('back')} All days</a>
      <div class="day-hero"><div><p class="eyebrow">${esc(v.name)}</p><h1>${esc(dayTitle(day, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' }))}</h1>
        <p class="lede muted">${plural(recs.length, 'recording')} · ${minutes} min of video · ${bytes(totalBytes)}${view$.category !== 'all' ? ` · ${esc(CATS.find((c) => c[0] === view$.category)?.[1])} only` : ''}</p></div>
        <div class="head-actions row">
          ${recs.length ? `<a class="btn btn-primary" href="#/viewer/${enc(v.id)}?day=${enc(day)}">${icon('play')} Play this day</a>` : ''}
          ${recs.length ? `<button class="btn" type="button" id="select-mode" aria-pressed="${selecting}">${icon('select')} ${selecting ? 'Done selecting' : 'Select'}</button>` : ''}
        </div></div>
      ${recs.length ? `<div class="rec-list">${sorted.map((r) => recCard(v, r, selecting, selected.has(r.id))).join('')}</div>`
        : emptyState({ art: 'film', title: 'Nothing left on this day', text: 'It may have moved to the Recycle Bin.', action: '<a class="btn btn-soft" href="#/bin">Open Recycle Bin</a>' })}
      ${recs.length ? `<div class="card" style="margin-top:22px"><h3>Tidy up this day</h3>
        <p class="muted small" style="margin:6px 0 12px">Protected recordings always stay. Everything else goes to the Recycle Bin, where you can restore it.</p>
        <div class="row"><button class="btn" type="button" id="trash-day">${icon('trash')} Move this day to Recycle Bin</button>
        <button class="btn btn-ghost" type="button" id="trash-through">Move this day and everything older…</button></div></div>` : ''}
      ${selecting ? `<div class="selbar" role="region" aria-label="Selected recordings"><b>${selected.size} selected</b><span class="spacer"></span>
        <button class="btn btn-sm" type="button" id="sel-all">${selected.size === recs.length ? 'Select none' : 'Select all'}</button>
        <button class="btn btn-sm" type="button" id="sel-protect"${selected.size ? '' : ' disabled'}>${icon('lock')} Protect</button>
        <button class="btn btn-sm" type="button" id="sel-unprotect"${recs.some((r) => selected.has(r.id) && r.protected) ? '' : ' disabled'}>${icon('unlock')} Unprotect</button>
        <button class="btn btn-primary btn-sm" type="button" id="sel-trash"${selected.size ? '' : ' disabled'}>${icon('trash')} Move to Recycle Bin</button></div>` : ''}
    </div>`;
    wire();
  };
  const refresh = async () => {
    try { await load(); } catch (err) { return fail(err); }
    if (ctx.alive()) draw();
    return undefined;
  };
  const byId = (id) => recs.find((r) => r.id === id);
  const wire = () => {
    view.querySelector('#select-mode')?.addEventListener('click', () => { selecting = !selecting; if (!selecting) selected.clear(); draw(); });
    view.querySelectorAll('.rec-card').forEach((el) => {
      const r = byId(el.dataset.id);
      el.querySelectorAll('[data-play]').forEach((b) => { b.onclick = () => go(`#/viewer/${enc(v.id)}/${enc(r.id)}?day=${enc(day)}`); });
      el.querySelector('[data-protect]').onclick = (e) => busy(e.currentTarget, async () => { if (await setProtected(v, [r.id], e.currentTarget.dataset.protect === 'on')) refresh(); });
      el.querySelector('[data-trash]')?.addEventListener('click', async (e) => { if (await busy(e.currentTarget, () => moveToBin(v, [r]))) refresh(); });
      el.querySelector('[data-select]')?.addEventListener('change', (e) => { if (e.target.checked) selected.add(r.id); else selected.delete(r.id); draw(); view.querySelector(`.rec-card[data-id="${CSS.escape(r.id)}"] [data-select]`)?.focus(); });
      const det = el.querySelector('[data-files]');
      if (openFiles.has(r.id)) det.open = true;
      const fill = async () => {
        try { det.querySelector('.more-body').innerHTML = await filesBody(v, r); } catch (err) { det.querySelector('.more-body').innerHTML = `<p class="muted">${esc(err.message)}</p>`; }
      };
      if (det.open) fill();
      det.addEventListener('toggle', () => { if (det.open) { openFiles.add(r.id); fill(); } else openFiles.delete(r.id); });
    });
    view.querySelector('#trash-day')?.addEventListener('click', (e) => busy(e.currentTarget, async () => { if (await trashDays(v, day, false)) setTimeout(refresh, 800); }));
    view.querySelector('#trash-through')?.addEventListener('click', (e) => busy(e.currentTarget, async () => { if (await trashDays(v, day, true)) setTimeout(refresh, 800); }));
    view.querySelector('#sel-all')?.addEventListener('click', () => { if (selected.size === recs.length) selected.clear(); else recs.forEach((r) => selected.add(r.id)); draw(); });
    view.querySelector('#sel-protect')?.addEventListener('click', (e) => busy(e.currentTarget, async () => { if (await setProtected(v, [...selected], true)) refresh(); }));
    view.querySelector('#sel-unprotect')?.addEventListener('click', (e) => busy(e.currentTarget, async () => { if (await setProtected(v, [...selected], false)) refresh(); }));
    view.querySelector('#sel-trash')?.addEventListener('click', (e) => busy(e.currentTarget, async () => {
      if (await moveToBin(v, recs.filter((r) => selected.has(r.id)))) { selected.clear(); refresh(); }
    }));
  };
  draw();
  ctx.on('topics', (t) => { if (t.includes('inventory') && !document.querySelector('dialog[open]') && !typing()) refresh(); });
  ctx.on('vehicle', () => go(`#/footage?vehicle=${enc(vehicle().id)}`));
  store.set('lastDay', day);
}
