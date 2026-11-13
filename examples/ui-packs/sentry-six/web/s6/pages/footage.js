import { icon } from '../icons.js';
import { ownedRender, scope } from '../core.js';
import { api, esc, act, sheet } from '../core.js';
import {
  dayLabel,
  timeRange,
  timeLabel,
  size,
  duration,
  plural,
  categoryEntries,
  categoryCount,
} from '../format.js';
import { createSelection, longPress, changeScope } from '../selection.js';
import { open as datepicker } from './datepicker.js';
const memories = new Map();
let lastVehicle;
export function clearFootageSelections() {
  for (const saved of memories.values()) {
    saved.selection.clear();
    saved.selecting = false;
  }
}
export async function playParams(base, day, rec) {
  if (!rec) return { day };
  const detail = await api(base + '/recordings/' + encodeURIComponent(rec.id));
  return { folder: detail.folderPath };
}
async function renderPage(el, ctx) {
  const { api, confirmDialog, toast } = ctx.scope;
  const { current, state, alive } = ctx;
  const admin = (await api('/api/auth/me')).role === 'admin';
  let v = current();
  if (!v) {
    el.innerHTML = admin
      ? '<h2>Add your first vehicle to get started.</h2><a href="#/settings/vehicles">Add a vehicle</a>'
      : '<h2>No vehicles yet.</h2><p>An administrator can add a vehicle.</p>';
    return;
  }
  const id = encodeURIComponent(v.id),
    base = `/api/vehicles/${id}`,
    query = new URLSearchParams(location.hash.split('?')[1] || '');
  if (lastVehicle !== v.id) {
    clearFootageSelections();
    lastVehicle = v.id;
  }
  let f = memories.get(v.id);
  if (!f) {
    f = {
      category: 'all',
      from: '',
      to: '',
      offset: 0,
      selecting: false,
      selection: createSelection(),
      expanded: new Set(),
      dayRecs: new Map(),
      limits: new Map(),
    };
    memories.set(v.id, f);
  }
  if (query.has('from') || query.has('to')) {
    changeScope(f, {
      from: query.get('from') || '',
      to: query.get('to') || '',
    });
    history.replaceState(null, '', '#/footage');
  }
  if (!admin) {
    f.selection.clear();
    f.selecting = false;
  }
  let stopped = false,
    drawSeq = 0,
    poll;
  const valid = () => alive() && !stopped;
  const params = (extra) =>
    new URLSearchParams({
      category: f.category,
      ...(f.from ? { from: f.from } : {}),
      ...(f.to ? { to: f.to } : {}),
      ...extra,
    });
  async function selectRecords(load) {
    const generation = f.selection.generation();
    const rows = await load();
    if (valid() && generation === f.selection.generation()) f.selection.add(rows.map((r) => r.id));
  }
  async function allRecords(extra = {}) {
    const all = [],
      scope = params().toString();
    for (let offset = 0; ; ) {
      const r = await api(`${base}/recordings?${params({ limit: 500, offset, ...extra })}`);
      if (!valid() || params().toString() !== scope) return [];
      all.push(...r.recordings);
      offset += r.recordings.length;
      if (offset >= r.total || !r.recordings.length) return all;
    }
  }
  async function records(day) {
    if (!f.dayRecs.has(day)) {
      const stamp = params().toString();
      const rows = await allRecords({ date: day });
      if (!valid() || stamp !== params().toString()) return [];
      f.dayRecs.set(day, rows);
    }
    return f.dayRecs.get(day);
  }
  let pendingAction;
  const cancelAction = () => pendingAction?.abort();
  const unsubscribeSelection = f.selection.subscribe(cancelAction);
  const scopeToken = () =>
    JSON.stringify([current()?.id, f.category, f.from, f.to, f.selection.generation()]);
  async function targets(ids, day, through, explicit) {
    if (!admin) return null;
    cancelAction();
    const token = scopeToken();
    const rows = await allRecords();
    if (!valid() || token !== scopeToken()) return null;
    const wanted = rows.filter((r) =>
      day ? (through ? r.day <= day : r.day === day) : ids.includes(r.id),
    );
    if (explicit) {
      f.selection.clear();
      f.selection.add(wanted.map((r) => r.id));
    }
    const selected = wanted.filter((r) => f.selection.has(r.id));
    const controller = scope(scopeToken, {
      signal: ctx.scope.signal,
      alive: valid,
    });
    pendingAction = controller;
    const stamp = scopeToken();
    const active = () => valid() && !controller.signal.aborted && stamp === scopeToken();
    return {
      ids: selected.map((r) => r.id),
      active,
      signal: controller.signal,
    };
  }
  async function protect(ids, on, day, explicit = false) {
    const flow = await targets(ids, day, false, explicit || !!day);
    if (!flow?.active() || !flow.ids.length) return;
    const yes = await confirmDialog({
      title: on ? 'Protect recordings?' : 'Unprotect recordings?',
      body: `<p>${plural(flow.ids.length, 'recording')} will be ${on ? 'protected' : 'unprotected'}.</p>`,
      ok: on ? 'Protect' : 'Unprotect',
      signal: flow.signal,
    });
    if (!flow.active() || !yes) return;
    await api(base + '/protect', {
      body: { ids: flow.ids, protected: on },
      signal: flow.signal,
    });
    if (!flow.active()) return;
    f.dayRecs.clear();
    await draw();
  }
  async function move(ids, day, through = false, explicit = false) {
    const flow = await targets(ids, day, through, explicit || !!day);
    if (!flow?.active() || !flow.ids.length) return;
    const body = { ids: flow.ids };
    const preview = await api(base + '/trash-preview', {
      body,
      signal: flow.signal,
    });
    if (!flow.active()) return;
    let withCan = false;
    const can = preview.can;
    if (!preview.recordings) {
      toast('Nothing to move. Protected recordings stay.');
      return;
    }
    const yes = await confirmDialog({
      title: through ? 'Move this day and older?' : 'Move to Recycle Bin?',
      body: `<p>${plural(flow.ids.length, 'selected recording')} submitted; ${plural(preview.recordings, 'recording')} move to the Recycle Bin. Protected recordings stay. You can restore the footage until the bin is emptied.</p>${can ? `<label><input type="checkbox" name="withCan" ${can.skip ? 'disabled' : ''}> Also delete its CAN data (${Number(can.logs || 0).toLocaleString()} logs)</label><p class="danger">${can.skip ? esc(can.skip) : 'CAN data is permanently deleted now. It does not come back if you restore the footage.'}</p>` : ''}`,
      ok: 'Move to Recycle Bin',
      danger: true,
      signal: flow.signal,
      onConfirm: (form) => {
        withCan = !!form.elements.withCan?.checked;
      },
    });
    if (!flow.active() || !yes) return;
    const out = await api(base + '/trash', {
      body: { ...body, withCan },
      signal: flow.signal,
    });
    if (!flow.active()) return;
    f.selection.clear();
    f.dayRecs.clear();
    toast(
      `${plural(out.moved?.length, 'recording')} moved to the Recycle Bin.${out.skipped?.length ? ' ' + out.skipped.length + ' skipped.' : ''}${out.can?.skip ? ' CAN data was not deleted: ' + out.can.skip : out.can ? ' ' + out.can.removed + ' CAN logs permanently deleted.' : ''}`,
    );
    await draw();
  }
  async function details(rec) {
    const d = await api(base + '/recordings/' + encodeURIComponent(rec.id));
    if (!valid()) return;
    const panel = document.createElement('section');
    panel.innerHTML = `<h2>Files and details</h2><p>${esc(d.folderPath)}</p>${d.files.map((x) => `<div class="row"><a class="grow" href="/api/media?path=${encodeURIComponent(x.path)}" download>${esc(x.rel)}</a><span>${size(x.size)}</span></div>`).join('')}`;
    sheet(panel);
  }
  function menu(anchor, actions) {
    const panel = document.createElement('section');
    panel.className = 'more-list';
    for (const [label, action] of actions) {
      const b = document.createElement('button');
      b.textContent = label;
      b.onclick = act(async () => {
        close();
        await action();
      });
      panel.append(b);
    }
    const close = sheet(panel, { anchor });
  }
  const play = async (day, rec) => {
    const params = await playParams(base, day, rec);
    if (valid()) location.hash = '#/viewer?' + new URLSearchParams(params);
  };
  function recording(r) {
    return `<div class="recording row">${f.selecting ? `<input type="checkbox" data-rec="${esc(r.id)}" aria-label="Select recording at ${esc(timeLabel(r.start, state.h24))}" ${f.selection.has(r.id) ? 'checked' : ''}>` : ''}<button class="thumb-play recording-thumb" data-play-rec="${esc(r.id)}" aria-label="Play recording"><img alt="" src="${base}/recordings/${encodeURIComponent(r.id)}/thumbnail"><span aria-hidden="true">${icon('play_fill')}</span></button><div class="grow"><b>${esc(timeRange(r.start, r.end || r.start, state.h24))}</b> <span class="tag category-${esc(r.category)}">${r.category === 'Recent' ? 'Driving' : esc(r.category)}</span><p>${r.eventAt ? 'Event at ' + esc(timeLabel(r.eventAt, state.h24)) + ' · ' : ''}<span class="value">${duration(r.minutes)}</span> · <span class="value">${size(r.bytes)}</span>${r.can ? ' · CAN' : ''}${r.protected ? ' · Protected' : ''}</p></div><button class="play-button" data-play-rec="${esc(r.id)}" aria-label="Play recording">${icon('play_fill')}</button><button class="icon-button" data-menu-rec="${esc(r.id)}" aria-label="Recording actions">${icon('more_horiz')}</button></div>`;
  }
  async function draw() {
    const ticket = ++drawSeq;
    const d = await api(base + '/days?' + params({ limit: 30, offset: f.offset }));
    if (!valid() || ticket !== drawSeq) return;
    const lastOffset = d.total > 0 ? Math.floor((d.total - 1) / 30) * 30 : 0;
    if (f.offset > lastOffset) {
      f.offset = lastOffset;
      return draw();
    }
    for (const day of d.days) {
      if (f.expanded.has(day.day) || f.selecting) await records(day.day);
    }
    if (!valid() || ticket !== drawSeq) return;
    const pager = () =>
      `<div class="row pager"><span class="grow">Days ${(d.total ? f.offset + 1 : 0).toLocaleString()}–${Math.min(f.offset + 30, d.total).toLocaleString()} of ${d.total.toLocaleString()}</span><button data-prev ${f.offset === 0 ? 'disabled' : ''} aria-label="Previous days">‹</button><button data-next ${f.offset + 30 >= d.total ? 'disabled' : ''} aria-label="Next days">›</button></div>`;
    el.innerHTML = `${!v.share?.healthy ? `<div class="card bad">Can't reach your footage share. ${esc(v.share?.lastError || '')}</div>` : ''}<div class="toolbar footage-actions"><a class="index-pill index-desktop" data-index href="#/activity" hidden></a><div class="grow"></div><a class="trips-link" href="#/drives">Trips & map</a>${f.selecting ? `<button data-all>Select all</button><b class="selected-count">${f.selection.count().toLocaleString()} selected</b>` : ''}${admin ? `<button data-select>${f.selecting ? 'Done' : 'Select'}</button>` : ''}</div><div class="toolbar footage-filters"><div class="segments">${['all', 'Recent', 'Sentry', 'Saved', ...(v.inventory?.byCategory?.Other ? ['Other'] : [])].map((k) => `<button data-category="${k}" class="${f.category === k ? 'active' : ''}">${k === 'all' ? 'All' : k === 'Recent' ? 'Driving' : k} <small>${Number(k === 'all' ? v.inventory?.recordings || 0 : v.inventory?.byCategory?.[k]?.recordings || 0).toLocaleString()}</small></button>`).join('')}</div><button data-date>${f.from || f.to ? esc((f.from ? dayLabel(f.from) : 'Any start') + ' – ' + (f.to ? dayLabel(f.to) : 'Any end')) : 'Any date'}</button>${f.from || f.to ? '<button data-clear-date aria-label="Clear date range">×</button>' : ''}${pager()}</div><a class="index-pill index-phone" data-index href="#/activity" hidden></a>${d.days.length ? '' : '<div class="empty">No footage matches these filters.</div>'}${d.days
      .map((day) => {
        const recs = f.dayRecs.get(day.day) || [],
          ids = recs.map((r) => r.id),
          selected = f.selection.dayState(ids),
          limit = f.limits.get(day.day) || 5;
        return `<article class="card day" data-day="${day.day}"><div class="row day-summary">${f.selecting ? `<input type="checkbox" data-day-check="${day.day}" data-mixed="${selected === 'some'}" ${selected === 'all' ? 'checked' : ''} aria-label="Select ${esc(dayLabel(day.day))}">` : ''}<button class="thumb-play day-thumb" data-play-day="${day.day}" aria-label="Play day"><img alt="" src="${base}/recordings/${encodeURIComponent(day.thumbId)}/thumbnail"><span aria-hidden="true">${icon('play_fill')}</span></button><button class="grow day-toggle" data-expand="${day.day}" aria-expanded="${f.expanded.has(day.day)}"><b>${esc(dayLabel(day.day))}</b><p>${categoryEntries(
          day.byCategory,
        )
          .map(
            ([k, n]) => `<span class="tag category-${esc(k)}">● ${esc(categoryCount(k, n))}</span>`,
          )
          .join(
            '',
          )}${day.archive?.state === 'filling' ? '<span class="tag arriving">Still arriving</span>' : ''}${day.protected ? '<span class="tag">' + Number(day.protected).toLocaleString() + ' protected</span>' : ''}${day.canRecordings ? '<span class="tag">CAN</span>' : ''}${day.speedIndex?.clips ? '<span class="tag">' + (day.speedIndex.indexed >= day.speedIndex.clips ? '✓ Indexed' : 'Indexing ' + Math.round((100 * day.speedIndex.indexed) / day.speedIndex.clips) + '%') + '</span>' : ''}</p><small><span class="value">${duration(day.minutes)}</span> · <span class="value">${plural(day.cameras, 'camera')}</span> · <span class="value">${size(day.bytes)}</span></small></button></div><div class="day-actions"><button class="play-button" data-play-day="${day.day}" aria-label="Play day">${icon('play_fill')}</button><button class="icon-button" data-menu-day="${day.day}" aria-label="Day actions">${icon('more_horiz')}</button></div><button class="expand-count" data-expand="${day.day}" aria-expanded="${f.expanded.has(day.day)}">${icon(f.expanded.has(day.day) ? 'expand_more' : 'chevron_right')}<span>${plural(day.recordings, 'recording')}</span></button>${f.expanded.has(day.day) ? `<div class="day-recs">${recs.slice(0, limit).map(recording).join('')}${recs.length > limit ? `<button data-show-more="${day.day}">Show ${plural(recs.length - limit, 'more recording')}</button>` : ''}</div>` : ''}</article>`;
      })
      .join(
        '',
      )}${pager()}${f.selecting ? `<div class="selection-bar"><b class="selected-count">${f.selection.count().toLocaleString()} selected</b><button data-protect ${f.selection.count() ? '' : 'disabled'}>Protect</button><button data-unprotect ${f.selection.count() ? '' : 'disabled'}>Unprotect</button><button data-move ${f.selection.count() ? '' : 'disabled'}><span class="desktop-label">Move to Recycle Bin</span><span class="phone-label">Move to Bin</span></button><button data-deselect ${f.selection.count() ? '' : 'disabled'}>Deselect all</button></div>` : ''}`;
    const headerActions = document.getElementById('page-actions');
    if (headerActions) {
      headerActions.replaceChildren(el.querySelector('.footage-actions'));
    }
    document.body.classList.toggle('selecting', f.selecting);
    el.querySelectorAll('[data-mixed=true]').forEach((x) => (x.indeterminate = true));
    el.querySelectorAll('img').forEach(
      (x) =>
        (x.onerror = () => {
          x.hidden = true;
        }),
    );
    el.onclick = act(async (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      const has = (k) => b.hasAttribute('data-' + k),
        day = b.dataset.expand || b.dataset.playDay || b.dataset.menuDay || b.dataset.showMore;
      if (!admin && ['select', 'all', 'deselect', 'protect', 'unprotect', 'move'].some(has)) return;
      if (has('select')) {
        f.selecting = !f.selecting;
        if (!f.selecting) f.selection.clear();
      } else if (has('all')) await selectRecords(() => allRecords());
      else if (has('deselect')) f.selection.clear();
      else if (has('category')) {
        changeScope(f, { category: b.dataset.category });
      } else if (has('prev')) f.offset = Math.max(0, f.offset - 30);
      else if (has('next')) f.offset += 30;
      else if (has('expand')) {
        if (f.expanded.has(day)) f.expanded.delete(day);
        else f.expanded.add(day);
      } else if (has('show-more')) f.limits.set(day, (f.dayRecs.get(day) || []).length);
      else if (has('date')) {
        datepicker(b, {
          from: f.from,
          to: f.to,
          daysWithFootage: new Set(d.dates),
          getSummary: async (range) => {
            const out = await api(
              base +
                '/days?' +
                new URLSearchParams({
                  category: f.category,
                  ...range,
                  limit: 1,
                }),
            );
            return { days: out.total, recordings: out.recordings };
          },
          onApply: (range) => {
            changeScope(f, range);
            draw().catch((e) => toast(e.message, true));
          },
        });
        return;
      } else if (has('clear-date')) {
        changeScope(f, { from: '', to: '' });
      } else if (has('play-day')) {
        await play(day);
        return;
      } else if (has('menu-day')) {
        menu(b, [
          ['Play day', () => play(day)],
          ...(admin
            ? [
                [
                  'Select this day',
                  async () => {
                    f.selecting = true;
                    await selectRecords(() => records(day));
                    await draw();
                  },
                ],
                ['Protect every recording', () => protect(null, true, day)],
                ['Move day to Recycle Bin', () => move(null, day)],
                ['Move this day and older…', () => move(null, day, true)],
              ]
            : []),
        ]);
        return;
      } else if (has('protect')) {
        await protect(f.selection.ids(), true);
        return;
      } else if (has('unprotect')) {
        await protect(f.selection.ids(), false);
        return;
      } else if (has('move')) {
        await move(f.selection.ids());
        return;
      } else if (has('menu-rec') || has('play-rec')) {
        const r = [...f.dayRecs.values()]
          .flat()
          .find((r) => r.id === (b.dataset.menuRec || b.dataset.playRec));
        if (!r) return;
        if (has('play-rec')) await play(r.day, r);
        else
          menu(b, [
            ...(admin
              ? [
                  [
                    r.protected ? 'Unprotect' : 'Protect',
                    () => protect([r.id], !r.protected, null, true),
                  ],
                  ['Move to Recycle Bin', () => move([r.id], null, false, true)],
                ]
              : []),
            ['Files and details', () => details(r)],
          ]);
        return;
      } else return;
      await draw();
    });
    if (headerActions) headerActions.onclick = el.onclick;
    el.onchange = act(async (e) => {
      const x = e.target;
      if (x.dataset.dayCheck) {
        const generation = f.selection.generation();
        const ids = (await records(x.dataset.dayCheck)).map((r) => r.id);
        if (!valid() || generation !== f.selection.generation()) return;
        x.checked ? f.selection.add(ids) : f.selection.remove(ids);
      } else if (x.dataset.rec) {
        x.checked ? f.selection.add([x.dataset.rec]) : f.selection.remove([x.dataset.rec]);
      } else return;
      await draw();
    });
    await indexStatus();
  }
  async function indexStatus() {
    if (!valid()) return;
    try {
      const s = await api('/api/speeds/status');
      for (const chip of document.querySelectorAll('[data-index]')) {
        if (!valid()) return;
        chip.hidden = !s.running;
        chip.textContent = s.running
          ? 'Indexing speed data' +
            (s.total ? ' · ' + Math.round((100 * s.done) / s.total) + '%' : '…')
          : '';
      }
    } catch {}
  }
  const changed = () => {
    if (!valid()) return;
    v = current();
    f.dayRecs.clear();
    draw().catch((e) => toast(e.message, true));
  };
  window.addEventListener('s6:changed', changed);
  const stopPress = longPress(el, '[data-day]', (row) => {
    if (!admin) return;
    f.selecting = true;
    selectRecords(() => records(row.dataset.day))
      .then(() => {
        return draw();
      })
      .catch((e) => toast(e.message, true));
  });
  const teardown = () => {
    cancelAction();
    unsubscribeSelection();
    stopPress();
    window.removeEventListener('s6:changed', changed);
    stopped = true;
    clearInterval(poll);
    const actions = document.getElementById('page-actions');
    if (actions && actions.onclick === el.onclick) {
      document.body.classList.remove('selecting');
      actions.replaceChildren();
      actions.onclick = null;
    }
    el.onclick = el.onchange = null;
  };
  ctx.scope.signal.addEventListener('abort', teardown, { once: true });
  await draw();
  if (!valid()) return teardown;
  poll = setInterval(indexStatus, 5000);
  return teardown;
}

export const render = ownedRender(renderPage);
