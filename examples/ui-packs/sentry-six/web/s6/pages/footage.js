import { api, esc, act, toast, sheet, confirmDialog } from '../core.js';
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
export async function render(el, { current, state, alive }) {
  const admin = (await api('/api/auth/me')).role === 'admin';
  let v = current();
  if (!v) {
    el.innerHTML =
      admin ? '<h2>Add your first vehicle to get started.</h2><a href="#/settings/vehicles">Add a vehicle</a>' : '<h2>No vehicles yet.</h2><p>An administrator can add a vehicle.</p>';
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
    if (!f.dayRecs.has(day)) f.dayRecs.set(day, await allRecords({ date: day }));
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
    const controller = new AbortController();
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
      body: `<p>${plural(flow.ids.length, 'selected recording')} submitted; ${plural(preview.recordings, 'recording')} move to the Recycle Bin. Protected recordings stay. You can restore the footage until the bin is emptied.</p>${can ? `<label><input type="checkbox" name="withCan" ${can.skip ? 'disabled' : ''}> Also delete its CAN data (${Number(can.logs || 0)} logs)</label><p class="danger">${can.skip ? esc(can.skip) : 'CAN data is permanently deleted now. It does not come back if you restore the footage.'}</p>` : ''}`,
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
    return `<div class="recording row">${f.selecting ? `<input type="checkbox" data-rec="${esc(r.id)}" aria-label="Select recording at ${esc(timeLabel(r.start, state.h24))}" ${f.selection.has(r.id) ? 'checked' : ''}>` : ''}<img alt="" src="${base}/recordings/${encodeURIComponent(r.id)}/thumbnail"><div class="grow"><b>${esc(timeRange(r.start, r.end || r.start, state.h24))}</b> <span class="tag category-${esc(r.category)}">${r.category === 'Recent' ? 'Driving' : esc(r.category)}</span><p>${r.eventAt ? 'Event at ' + esc(timeLabel(r.eventAt, state.h24)) + ' · ' : ''}${duration(r.minutes)} · ${size(r.bytes)}${r.can ? ' · CAN' : ''}${r.protected ? ' · Protected' : ''}</p></div><button class="play-button" data-play-rec="${esc(r.id)}" aria-label="Play recording">▶</button><button data-menu-rec="${esc(r.id)}" aria-label="Recording actions">⋯</button></div>`;
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
      `<div class="row pager"><span class="grow">Days ${d.total ? f.offset + 1 : 0}–${Math.min(f.offset + 30, d.total)} of ${d.total}</span><button data-prev ${f.offset === 0 ? 'disabled' : ''} aria-label="Previous days">‹</button><button data-next ${f.offset + 30 >= d.total ? 'disabled' : ''} aria-label="Next days">›</button></div>`;
    el.innerHTML = `${!v.share?.healthy ? `<div class="card bad">Can't reach your footage share. ${esc(v.share?.lastError || '')}</div>` : ''}<div class="toolbar footage-actions"><a data-index href="#/activity" hidden></a><div class="grow"></div><a href="#/drives">Trips & map</a>${f.selecting ? `<button data-all>Select all</button><b>${f.selection.count()} selected</b>` : ''}${admin ? `<button data-select>${f.selecting ? 'Done' : 'Select'}</button>` : ''}</div><div class="toolbar footage-filters"><div class="segments">${['all', 'Recent', 'Sentry', 'Saved', ...(v.inventory?.byCategory?.Other ? ['Other'] : [])].map((k) => `<button data-category="${k}" class="${f.category === k ? 'active' : ''}">${k === 'all' ? 'All' : k === 'Recent' ? 'Driving' : k} <small>${k === 'all' ? v.inventory?.recordings || 0 : v.inventory?.byCategory?.[k]?.recordings || 0}</small></button>`).join('')}</div><button data-date>${f.from || f.to ? esc((f.from ? dayLabel(f.from) : 'Any start') + ' – ' + (f.to ? dayLabel(f.to) : 'Any end')) : 'Any date'}</button>${f.from || f.to ? '<button data-clear-date aria-label="Clear date range">×</button>' : ''}${pager()}</div>${d.days.length ? '' : '<div class="empty">No footage matches these filters.</div>'}${d.days
      .map((day) => {
        const recs = f.dayRecs.get(day.day) || [],
          ids = recs.map((r) => r.id),
          selected = f.selection.dayState(ids),
          limit = f.limits.get(day.day) || 5;
        return `<article class="card day" data-day="${day.day}"><div class="row">${f.selecting ? `<input type="checkbox" data-day-check="${day.day}" data-mixed="${selected === 'some'}" ${selected === 'all' ? 'checked' : ''} aria-label="Select ${esc(dayLabel(day.day))}">` : ''}<img class="day-thumb" alt="" src="${base}/recordings/${encodeURIComponent(day.thumbId)}/thumbnail"><button class="grow day-toggle" data-expand="${day.day}" aria-expanded="${f.expanded.has(day.day)}"><b>${esc(dayLabel(day.day))}</b><p>${categoryEntries(
          day.byCategory,
        )
          .map(
            ([k, n]) => `<span class="tag category-${esc(k)}">● ${esc(categoryCount(k, n))}</span>`,
          )
          .join(
            '',
          )}${day.archive?.state === 'filling' ? '<span class="tag arriving">Still arriving</span>' : ''}${day.protected ? '<span class="tag">' + day.protected + ' protected</span>' : ''}${day.canRecordings ? '<span class="tag">CAN</span>' : ''}${day.speedIndex?.clips ? '<span class="tag">' + (day.speedIndex.indexed >= day.speedIndex.clips ? '✓ Indexed' : 'Indexing ' + Math.round((100 * day.speedIndex.indexed) / day.speedIndex.clips) + '%') + '</span>' : ''}</p><small>${duration(day.minutes)} · ${plural(day.cameras, 'camera')} · ${size(day.bytes)}</small></button><button class="play-button" data-play-day="${day.day}" aria-label="Play day">▶</button><button data-menu-day="${day.day}" aria-label="Day actions">⋯</button></div><button class="expand-count" data-expand="${day.day}">${f.expanded.has(day.day) ? '⌄' : '›'} ${plural(day.recordings, 'recording')}</button>${f.expanded.has(day.day) ? `<div>${recs.slice(0, limit).map(recording).join('')}${recs.length > limit ? `<button data-show-more="${day.day}">Show ${plural(recs.length - limit, 'more recording')}</button>` : ''}</div>` : ''}</article>`;
      })
      .join(
        '',
      )}${pager()}${f.selecting ? `<div class="selection-bar"><b>${f.selection.count()} selected</b><button data-protect>Protect</button><button data-unprotect>Unprotect</button><button data-move>Move to Recycle Bin</button><button data-deselect>Deselect all</button></div>` : ''}`;
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
      } else if (has('all')) f.selection.add((await allRecords()).map((r) => r.id));
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
                    f.selection.add((await records(day)).map((r) => r.id));
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
        const ids = (await records(x.dataset.dayCheck)).map((r) => r.id);
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
      const chip =
        document.querySelector('#page-actions [data-index]') || el.querySelector('[data-index]');
      if (!chip || !valid()) return;
      chip.hidden = !s.running;
      chip.textContent = s.running
        ? 'Indexing speed data' +
          (s.total ? ' · ' + Math.round((100 * s.done) / s.total) + '%' : '…')
        : '';
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
    records(row.dataset.day)
      .then((recs) => {
        f.selection.add(recs.map((r) => r.id));
        return draw();
      })
      .catch((e) => toast(e.message, true));
  });
  await draw();
  poll = setInterval(indexStatus, 5000);
  return () => {
    cancelAction();
    unsubscribeSelection();
    stopPress();
    window.removeEventListener('s6:changed', changed);
    stopped = true;
    clearInterval(poll);
    document.body.classList.remove('selecting');
    const actions = document.getElementById('page-actions');
    if (actions) {
      actions.replaceChildren();
      actions.onclick = null;
    }
    el.onclick = el.onchange = null;
  };
}
