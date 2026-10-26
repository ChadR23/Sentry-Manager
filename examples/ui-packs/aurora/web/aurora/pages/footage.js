// Footage: a filmstrip of days (thumbnails, newest first, scroll sideways),
// and under it the recordings of the chosen day as glass cards: play, protect,
// move to the Recycle Bin (one, several, the day, or "through this date"),
// and the files of each with their codecs and downloads.

import {
  $, $$, esc, icon, api, current, vehiclePicker, bytes, plural, dayParts, dayTitle, timeOf, humanize, toast, confirmDialog, empty, loadVehicles
} from '../core.js';

const PAGE = 30;
const CATS = [['all', 'All'], ['Recent', 'Drives'], ['Sentry', 'Sentry'], ['Saved', 'Saved'], ['Other', 'Other']];
const CAT_CHIP = { Recent: 'teal', Sentry: 'magenta', Saved: 'green', Other: 'violet' };
const CODEC = { h265: 'H.265', av1: 'AV1', h264: 'H.264' };
const ENCODED = new Set(['h265', 'av1']);
const keep = { category: 'all', protectedOnly: false, vehicleId: null };

const thumb = (v, id) => `/api/vehicles/${encodeURIComponent(v.id)}/recordings/${encodeURIComponent(id)}/thumbnail`;

function frame(v, d, on) {
  const p = dayParts(d.day);
  const cats = Object.entries(d.byCategory || {}).filter(([, n]) => n);
  const enc = d.encodedRecordings ? (d.encodedRecordings === d.recordings ? 'all encoded' : `${d.encodedRecordings}/${d.recordings} encoded`) : '';
  return `<button class="frame${on ? ' on' : ''}" type="button" data-day="${esc(d.day)}" aria-pressed="${on}" aria-label="${esc(dayTitle(d.day))}: ${plural(d.recordings, 'recording')}, ${esc(bytes(d.bytes))}">
    <div class="frame-pic">${d.thumbId ? `<img class="thumb-img" loading="lazy" alt="" src="${thumb(v, d.thumbId)}">` : ''}<div class="frame-date"><b>${esc(p.dd)}</b><span>${esc(p.mon)} · ${esc(p.wd)}</span></div></div>
    <div class="frame-info"><span class="frame-cats">${cats.map(([c, n]) => `<span class="chip ${CAT_CHIP[c] || ''}" style="padding:1px 8px;font-size:12px"><i class="dot cat-${esc(c)}"></i>${n}</span>`).join('')}</span>
      <span class="muted">${d.minutes} min · ${esc(bytes(d.bytes))}${d.protected ? ` · ${d.protected} protected` : ''}${enc ? ` · ${enc}` : ''}</span></div>
  </button>`;
}

function encodedChip(r) {
  const e = r.encoded;
  if (!e || !e.clips || !e.encoded) return '';
  const names = (e.codecs || []).map((c) => CODEC[c] || c).join(' + ');
  return `<span class="chip violet">${e.encoded === e.clips ? `${esc(names)}` : `${e.encoded}/${e.clips} encoded`}</span>`;
}

function card(v, r, selected, open) {
  const range = r.end && r.end !== r.start ? `${timeOf(r.start)}–${timeOf(r.end)}` : timeOf(r.start);
  return `<article class="rec${selected ? ' sel' : ''}" data-id="${esc(r.id)}">
    <button class="rec-pic" type="button" data-play aria-label="Play ${esc(r.category)} recording at ${esc(range)}">
      ${r.thumbRel || r.frontRel ? `<img class="thumb-img" loading="lazy" alt="" src="${thumb(v, r.id)}">` : ''}
      <span class="tags"><span class="chip ${CAT_CHIP[r.category] || ''}">${esc(r.category)}</span>${r.protected ? `<span class="chip green">${icon('lock')}Protected</span>` : ''}${encodedChip(r)}</span>
      <span class="play-orb">${icon('play')}</span>
    </button>
    <div class="rec-body">
      <div class="rec-time">${esc(range)}</div>
      <div class="rec-meta"><span>${r.minutes} min</span><span>${plural(r.cameras.length, 'camera')}</span><span>${plural(r.fileCount, 'file')}</span><span>${esc(bytes(r.bytes))}</span>${r.eventAt ? `<span>event ${esc(timeOf(r.eventAt))}</span>` : ''}</div>
      <div class="rec-acts">
        <label class="check"><input type="checkbox" data-pick${selected ? ' checked' : ''}> Select</label>
        <button class="btn sm" type="button" data-protect="${r.protected ? 'off' : 'on'}">${icon(r.protected ? 'unlock' : 'lock')}${r.protected ? 'Unprotect' : 'Protect'}</button>
        ${r.protected ? '' : `<button class="btn sm" type="button" data-trash>${icon('trash')}Bin</button>`}
        <button class="btn sm ghost" type="button" data-files aria-expanded="${open}">${open ? 'Hide files' : 'Files'}</button>
      </div>
      ${open ? `<ul class="files" data-files-list><li><span class="muted">Loading…</span></li></ul>` : ''}
    </div>
  </article>`;
}

export default {
  title: 'Footage',
  kicker: 'Filmstrip',
  icon: 'film',
  vehicle: true,
  topics: ['inventory', 'vehicles'],
  async mount(ctx) {
    const { body, actions } = ctx;
    const v = current();
    actions.innerHTML = `${vehiclePicker()}${v ? `<button class="btn" type="button" id="rescan">${icon('refresh')} Refresh</button><a class="btn" href="#/encoder">${icon('orbit')} Convert</a>` : ''}`;
    if (!v) {
      body.innerHTML = empty('No vehicle yet', 'Add one in Settings to see its footage.', `<a class="btn primary" href="#/settings/vehicles/new">${icon('plus')} Add a vehicle</a>`);
      return {};
    }
    if (keep.vehicleId !== v.id) Object.assign(keep, { vehicleId: v.id });
    let days = [];
    let total = 0;
    let dates = [];
    let chosen = ctx.params[0] || null;
    let recs = [];
    const selected = new Set();
    const open = new Set();
    let dead = false;
    let meta = null;
    let stripHtml = '';
    let dayHtml = '';

    body.innerHTML = `<div class="foot-bar">
        <div class="field"><span>Show</span><div class="seg" role="group" aria-label="Category">${CATS.map(([k, label]) => `<button type="button" data-cat="${k}" aria-pressed="${keep.category === k}">${label}</button>`).join('')}</div></div>
        <label class="check" style="align-self:flex-end"><input type="checkbox" id="prot"${keep.protectedOnly ? ' checked' : ''}> Protected only</label>
        <label class="field" style="margin-left:auto">Jump to a date<input class="input" type="date" id="jump"></label>
      </div>
      <p class="muted small" id="foot-sum"></p>
      <div class="filmstrip-wrap">
        <button class="btn icon strip-nav l glass" type="button" data-strip="-1" aria-label="Scroll to newer days">${icon('left')}</button>
        <div class="filmstrip" id="strip" role="group" aria-label="Days, newest first"></div>
        <button class="btn icon strip-nav r glass" type="button" data-strip="1" aria-label="Scroll to older days">${icon('right')}</button>
      </div>
      <div id="day"></div>`;
    const strip = $('#strip', body);
    const dayBox = $('#day', body);

    const q = (extra = {}) => new URLSearchParams({ category: keep.category, ...extra });

    async function loadDays(append = false) {
      const out = await api(`/api/vehicles/${encodeURIComponent(v.id)}/days?${q({ offset: String(append ? days.length : 0), limit: String(append ? PAGE : Math.max(PAGE, days.length)) })}`);
      if (dead) return;
      meta = out;
      total = out.total;
      dates = out.dates || [];
      days = append ? [...days, ...out.days] : out.days;
      if (!chosen || (!days.some((d) => d.day === chosen) && !append)) chosen = days[0]?.day || null;
      drawStrip();
    }

    function drawStrip() {
      $('#foot-sum', body).textContent = `${plural(total, 'day')} · ${plural(meta?.recordings || 0, 'recording')}${meta?.scanning ? ' · scanning…' : ''} · times in the vehicle’s time zone (${v.timezone || 'UTC'})`;
      const jump = $('#jump', body);
      if (dates.length) { jump.min = dates[dates.length - 1]; jump.max = dates[0]; }
      if (!days.length) {
        strip.innerHTML = '';
        dayBox.innerHTML = empty(meta?.error ? 'The footage can’t be read' : meta?.scanning ? 'Scanning…' : 'No footage here', meta?.error ? esc(meta.error) : keep.category !== 'all' || keep.protectedOnly ? 'Try another filter.' : 'Recordings show up here once the vehicle has some.');
        return;
      }
      const html = days.map((d) => frame(v, d, d.day === chosen)).join('')
        + (days.length < total ? `<button class="frame more-days" type="button" id="older">${icon('right')}<span>Older days<br><span class="muted small">${total - days.length} more</span></span></button>` : '');
      // a live update with nothing new leaves the strip (and the focus in it) alone
      if (html === stripHtml && strip.childElementCount) return;
      stripHtml = html;
      const sx = strip.scrollLeft;
      strip.innerHTML = html;
      strip.scrollLeft = sx;
    }

    async function loadDay() {
      if (!chosen) return;
      const day = chosen;
      if (!dayBox.querySelector('.day-head') || dayBox.dataset.day !== day) { dayBox.innerHTML = '<p class="loading">Loading the recordings…</p>'; dayHtml = ''; }
      dayBox.dataset.day = day;
      try {
        const extra = { date: day, limit: '500' };
        if (keep.protectedOnly) extra.protected = '1';
        const out = await api(`/api/vehicles/${encodeURIComponent(v.id)}/recordings?${q(extra)}`);
        if (dead || day !== chosen) return;
        recs = out.recordings.sort((a, b) => String(a.start).localeCompare(String(b.start)));
      } catch (err) {
        dayBox.innerHTML = `<p class="note bad">${esc(err.message)}</p>`;
        return;
      }
      drawDay();
    }

    function drawDay() {
      const d = days.find((x) => x.day === chosen);
      const sel = recs.filter((r) => selected.has(r.id));
      const html = `<div class="day-head"><div><p class="muted small">${d ? `${plural(d.recordings, 'recording')} · ${d.minutes} min · ${esc(bytes(d.bytes))}` : ''}</p><h2>${esc(dayTitle(chosen))}</h2></div>
        <div class="row"><a class="btn primary" href="#/viewer/${encodeURIComponent(v.id)}/day/${encodeURIComponent(chosen)}">${icon('play')} Play day</a>
          <button class="btn" type="button" data-select-all>${icon('select')} Select all</button>
          <button class="btn" type="button" data-trash-day="day">${icon('trash')} Delete this day</button>
          <button class="btn" type="button" data-trash-day="through">Delete through this date</button></div></div>
        ${selected.size ? `<div class="selbar" role="region" aria-label="Selection"><b>${selected.size} selected</b><span class="spacer"></span>
          <button class="btn sm" type="button" data-bulk="protect">${icon('lock')} Protect</button>
          <button class="btn sm" type="button" data-bulk="unprotect"${sel.some((r) => r.protected) ? '' : ' disabled'}>${icon('unlock')} Unprotect</button>
          <button class="btn sm danger" type="button" data-bulk="trash">${icon('trash')} Move to Bin</button>
          <button class="btn sm ghost" type="button" data-bulk="clear">Clear</button></div>` : ''}
        ${recs.length ? `<div class="recs">${recs.map((r) => card(v, r, selected.has(r.id), open.has(r.id))).join('')}</div>` : empty('Nothing that day', keep.protectedOnly ? 'No protected recordings that day.' : 'No recordings match this filter.')}`;
      if (html === dayHtml && dayBox.querySelector('.day-head')) return;
      dayHtml = html;
      dayBox.innerHTML = html;
      for (const id of open) loadFiles(id);
    }

    async function loadFiles(id) {
      const list = $(`.rec[data-id="${CSS.escape(id)}"] [data-files-list]`, dayBox);
      if (!list) return;
      try {
        const d = await api(`/api/vehicles/${encodeURIComponent(v.id)}/recordings/${encodeURIComponent(id)}`);
        const ev = d.event ? `<li><span>${icon('pin', 'ico-sm')} ${esc([humanize(d.event.reason), d.event.city, d.event.street].filter(Boolean).join(' · ') || 'Event')}</span><span></span><span></span></li>` : '';
        list.innerHTML = ev + d.files.map((f) => `<li><span title="${esc(f.rel)}">${esc(f.rel.split('/').pop())}</span><span>${'codec' in f ? (f.codec ? `<span class="chip ${ENCODED.has(f.codec) ? 'violet' : ''}" style="font-size:12px;padding:1px 8px">${esc(CODEC[f.codec] || f.codec)}</span>` : '<span class="muted">checking</span>') : ''} <span class="muted">${esc(bytes(f.size))}</span></span><a class="btn icon ghost" href="/api/media?path=${encodeURIComponent(f.path)}" download aria-label="Download ${esc(f.rel.split('/').pop())}">${icon('download', 'ico-sm')}</a></li>`).join('');
      } catch (err) {
        list.innerHTML = `<li><span>${esc(err.message)}</span></li>`;
      }
    }

    async function protect(ids, on) {
      try {
        await api(`/api/vehicles/${encodeURIComponent(v.id)}/protect`, { body: { ids, protected: on } });
        toast(on ? 'Protected: policies and the Bin leave it alone.' : 'Protection removed.');
      } catch (err) { toast(err.message, 'bad'); }
      await loadDay();
    }

    async function trash(ids) {
      const list = recs.filter((r) => ids.includes(r.id));
      const size = list.reduce((n, r) => n + r.bytes, 0);
      if (!(await confirmDialog({
        title: `Move ${plural(ids.length, 'recording')} to the Recycle Bin?`,
        body: `<p>${esc(bytes(size))} moves to the Recycle Bin on the same share. Nothing is deleted: restore it from the Bin any time.</p>${list.some((r) => r.protected) ? '<p>Protected recordings are skipped.</p>' : ''}`,
        ok: 'Move to Bin'
      }))) return;
      try {
        const out = await api(`/api/vehicles/${encodeURIComponent(v.id)}/trash`, { body: { ids } });
        const why = out.skipped?.length ? ` ${out.skipped.length} skipped (${[...new Set(out.skipped.map((s) => s.reason))].join(', ')}).` : '';
        toast(`${plural(out.moved?.length || 0, 'recording')} moved to the Bin (${bytes(out.bytes)}).${why}`, out.skipped?.length && !out.moved?.length ? 'bad' : 'ok');
        ids.forEach((id) => selected.delete(id));
      } catch (err) { toast(err.message, 'bad'); }
      await loadVehicles().catch(() => {});
      await loadDays();
      await loadDay();
    }

    async function trashDays(through) {
      const req = { day: chosen, through, category: keep.category };
      let pre;
      try {
        pre = await api(`/api/vehicles/${encodeURIComponent(v.id)}/trash-days`, { body: { ...req, preview: true } });
      } catch (err) { toast(err.message, 'bad'); return; }
      if (!pre.recordings) {
        toast(pre.protected ? 'Everything there is protected: nothing to move.' : 'Nothing to move.');
        return;
      }
      const what = through ? `${esc(dayTitle(chosen))} and every older day` : esc(dayTitle(chosen));
      if (!(await confirmDialog({
        title: through ? 'Delete through this date?' : 'Delete this day?',
        body: `<p>${plural(pre.recordings, 'recording')} from ${what}${keep.category === 'all' ? '' : ` (${esc(keep.category)} only)`}, ${esc(bytes(pre.bytes))}${through && pre.days > 1 ? ` over ${plural(pre.days, 'day')}` : ''}, move to the Recycle Bin.</p>
          <p class="muted">Nothing is deleted for good until you empty the Bin.${pre.protected ? ` ${plural(pre.protected, 'protected recording')} stay${pre.protected === 1 ? 's' : ''}.` : ''}</p>`,
        ok: through ? 'Delete through this date' : 'Delete this day',
        danger: true
      }))) return;
      try {
        const out = await api(`/api/vehicles/${encodeURIComponent(v.id)}/trash-days`, { body: req });
        toast(`Moving ${plural(out.recordings, 'recording')} (${bytes(out.bytes)}) to the Bin. Jobs shows the progress.`);
        selected.clear();
      } catch (err) { toast(err.message, 'bad'); }
    }

    const choose = (day, scroll = true) => {
      if (!day || day === chosen) return;
      chosen = day;
      selected.clear();
      history.replaceState(null, '', `#/footage/${encodeURIComponent(day)}`);
      $$('.frame[data-day]', strip).forEach((f) => {
        const on = f.dataset.day === day;
        f.classList.toggle('on', on);
        f.setAttribute('aria-pressed', String(on));
        if (on && scroll) f.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'smooth' });
      });
      loadDay();
    };

    body.addEventListener('click', async (e) => {
      const t = e.target;
      const cat = t.closest('[data-cat]');
      if (cat) {
        keep.category = cat.dataset.cat;
        $$('[data-cat]', body).forEach((b) => b.setAttribute('aria-pressed', String(b === cat)));
        selected.clear();
        await loadDays();
        await loadDay();
        return;
      }
      const fr = t.closest('.frame[data-day]');
      if (fr) { choose(fr.dataset.day, false); return; }
      if (t.closest('#older')) { await loadDays(true); return; }
      const nav = t.closest('[data-strip]');
      if (nav) { strip.scrollBy({ left: Number(nav.dataset.strip) * strip.clientWidth * 0.8, behavior: 'smooth' }); return; }
      if (t.closest('[data-select-all]')) { recs.forEach((r) => selected.add(r.id)); drawDay(); return; }
      const td = t.closest('[data-trash-day]');
      if (td) { trashDays(td.dataset.trashDay === 'through'); return; }
      const bulk = t.closest('[data-bulk]');
      if (bulk) {
        const ids = [...selected];
        if (bulk.dataset.bulk === 'clear') { selected.clear(); drawDay(); } else if (bulk.dataset.bulk === 'trash') trash(ids);
        else protect(ids, bulk.dataset.bulk === 'protect');
        return;
      }
      const rec = t.closest('.rec');
      if (!rec) return;
      const id = rec.dataset.id;
      if (t.closest('[data-play]')) { ctx.go(`#/viewer/${encodeURIComponent(v.id)}/${encodeURIComponent(id)}`); return; }
      const pr = t.closest('[data-protect]');
      if (pr) { protect([id], pr.dataset.protect === 'on'); return; }
      if (t.closest('[data-trash]')) { trash([id]); return; }
      if (t.closest('[data-files]')) {
        if (open.has(id)) open.delete(id);
        else open.add(id);
        drawDay();
      }
    });
    body.addEventListener('change', async (e) => {
      const t = e.target;
      if (t.id === 'prot') { keep.protectedOnly = t.checked; await loadDay(); return; }
      if (t.id === 'jump' && t.value) {
        const want = t.value;
        const has = dates.includes(want) ? want : dates.find((d) => d <= want) || dates[dates.length - 1];
        if (!has) return;
        while (!days.some((d) => d.day === has) && days.length < total) await loadDays(true);
        choose(has);
        return;
      }
      if (t.matches('[data-pick]')) {
        const id = t.closest('.rec').dataset.id;
        if (t.checked) selected.add(id);
        else selected.delete(id);
        drawDay();
      }
    });
    strip.addEventListener('keydown', (e) => {
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
      const i = days.findIndex((d) => d.day === chosen);
      const next = days[i + (e.key === 'ArrowRight' ? 1 : -1)];
      if (next) {
        e.preventDefault();
        choose(next.day);
        $(`.frame[data-day="${CSS.escape(next.day)}"]`, strip)?.focus();
      }
    });
    $('#rescan', actions)?.addEventListener('click', async () => {
      try {
        await api(`/api/vehicles/${encodeURIComponent(v.id)}/scan`, { body: {} });
        toast('Looking through the footage again…');
      } catch (err) { toast(err.message, 'bad'); }
    });

    await loadDays();
    if (chosen) {
      const f = $(`.frame[data-day="${CSS.escape(chosen)}"]`, strip);
      f?.scrollIntoView({ block: 'nearest', inline: 'center' });
      await loadDay();
    }
    return {
      async refresh() {
        await loadDays();
        await loadDay();
      },
      destroy() { dead = true; }
    };
  }
};
