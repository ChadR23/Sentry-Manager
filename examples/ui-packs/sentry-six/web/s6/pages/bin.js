import { ownedRender, scope } from '../core.js';
import { esc, act, sheet } from '../core.js';
import { binNote, expiresIn } from '../bin.js';
import { createSelection, longPress } from '../selection.js';
import { plural, dayLabel, timeLabel, dayKey, size } from '../format.js';
import { icon } from '../icons.js';
async function renderPage(el, ctx) {
  const { api, confirmDialog, toast } = ctx.scope;
  const { current, state, alive } = ctx;
  const admin = (await api('/api/auth/me')).role === 'admin';
  const v = current();
  if (!v) {
    el.innerHTML = '<div class="empty">The Recycle Bin is empty</div>';
    return;
  }
  const selection = createSelection();
  let stopped = false,
    pending;
  const valid = () => !stopped && alive();
  const cancel = () => pending?.abort();
  const unsubscribe = selection.subscribe(cancel);
  let selecting = false,
    reason = '',
    items = [],
    policy = {},
    busy = false,
    progress = null,
    outcome = '';
  async function load() {
    const [b, p] = await Promise.all([
      api('/api/bin?vehicle=' + encodeURIComponent(v.id)),
      api('/api/vehicles/' + encodeURIComponent(v.id) + '/policy'),
    ]);
    if (!valid()) return;
    items = b.items || [];
    policy = p.policy || p;
    draw();
  }
  async function run(ids, action) {
    if (!admin || busy || !valid()) return;
    cancel();
    const controller = scope(() => [current()?.id, reason, selection.generation()], {
      signal: ctx.scope.signal,
      alive: valid,
    });
    pending = controller;
    const active = controller.alive;
    if (
      action === 'delete' &&
      !(await confirmDialog({
        signal: controller.signal,
        title: 'Delete forever?',
        body: `<p>${plural(ids.length, 'item')} will be permanently deleted. This cannot be undone.</p>`,
        ok: 'Delete forever',
        danger: true,
      }))
    )
      return;
    if (!active()) return;
    busy = true;
    outcome = '';
    progress = { action, total: ids.length, at: 0 };
    draw();
    let completed = 0;
    const failures = [];
    try {
      for (const id of ids) {
        if (!active()) break;
        progress.at++;
        draw();
        try {
          const result = await api('/api/bin/' + encodeURIComponent(id) + '/' + action, {
            body: action === 'delete' ? { confirm: true } : {},
            signal: controller.signal,
          });
          if (!active()) break;
          if (action === 'restore' && result.conflicts) {
            failures.push('a file with that name exists');
          } else {
            completed++;
            items = items.filter((item) => item.id !== id);
          }
        } catch (e) {
          if (!active()) break;
          failures.push(e.message);
        }
      }
    } finally {
      controller.abort();
      progress = null;
      if (valid()) {
        selection.clear();
        draw(); // Retain successful removals even if the subsequent GET fails.
        try {
          await load();
        } catch (e) {
          if (valid()) failures.push('Could not refresh: ' + e.message);
        }
        if (valid()) {
          busy = false;
          outcome = `${action === 'restore' ? 'Restored' : 'Deleted'} ${completed}; ${failures.length} failed${failures.length ? ': ' + [...new Set(failures)].join('; ') : ''}`;
          draw();
          toast(outcome, failures.length > 0);
        }
      }
    }
  }

  function draw() {
    if (!valid()) return;
    const total = items.reduce((n, i) => n + i.bytes, 0),
      visible = items.filter((i) => !reason || i.reason === reason),
      groups = new Map();
    for (const i of visible) {
      const group =
        (i.reason === 'policy'
          ? 'Cleanup rules'
          : i.reason === 'recovered'
            ? 'Recovered'
            : 'Moved by you') +
        ' · ' +
        dayLabel(dayKey(new Date(i.trashedAt)));
      if (!groups.has(group)) groups.set(group, []);
      groups.get(group).push(i);
    }
    el.innerHTML = `<div class="toolbar"><span class="grow"></span>${selecting ? `<button data-all>Select all</button><b>${selection.count()} selected</b>` : ''}${admin ? `<button data-select>${selecting ? 'Done' : 'Select'}</button>` : ''}</div>${items.length || progress || outcome ? `<section class="card"><div class="number">${plural(items.length, 'item')} · ${size(total)}</div><p>Emptying the bin frees ${size(total)} on the share${v.storage?.perDay > 0 ? (total < v.storage.perDay ? ', less than one more day of recording' : ', about ' + Math.floor(total / v.storage.perDay) + ' more days of recording') : ''}.</p>${admin ? `<div class="row"><button data-restore-all ${busy ? 'disabled' : ''}>Restore all</button><button class="danger" data-empty ${busy ? 'disabled' : ''}>Empty Recycle Bin</button></div>` : ''}${progress ? `<div role="status" aria-live="polite"><p>${progress.action === 'restore' ? 'Restoring' : 'Deleting'} ${progress.at} of ${progress.total}…</p><progress value="${progress.at - 1}" max="${progress.total}"></progress></div>` : outcome ? `<p role="status">${esc(outcome)}</p>` : ''}</section>` : '<div class="empty"><h2>The Recycle Bin is empty</h2><p>Footage moved here can be restored until it is deleted permanently.</p></div>'}<div class="segments">${[
      ['', 'All'],
      ['manual', 'Moved by you'],
      ['policy', 'Cleanup rules'],
      ['recovered', 'Recovered'],
    ]
      .map(
        ([r, l]) =>
          `<button data-reason="${r}" class="${reason === r ? 'active' : ''}">${l}</button>`,
      )
      .join('')}</div><p>${esc(binNote(policy))}</p>${[...groups]
      .map(
        ([g, rows]) =>
          `<h3>${esc(g)}</h3><section class="card">${rows
            .map((i) => {
              const expiry = expiresIn(i, policy);
              return `<div class="recording row" data-bin-row="${esc(i.id)}">${selecting ? `<input data-id="${esc(i.id)}" type="checkbox" aria-label="Select item" ${selection.has(i.id) ? 'checked' : ''}>` : ''}<span class="bin-thumb">${icon(i.category === 'Recent' ? 'videocam' : 'shield')}<img alt="" src="/api/bin/${encodeURIComponent(i.id)}/thumbnail"></span><div class="grow"><b>${i.category === 'Recent' ? 'Driving' : esc(i.category)} · ${dayLabel(i.startAt?.slice(0, 10))}</b><p>${timeLabel(i.startAt, state.h24)} · ${plural(i.fileCount ?? i.files?.length ?? 0, 'file')} · ${size(i.bytes)}</p>${expiry != null ? `<p class="${expiry < 3 ? 'warn' : ''}">Deleted for good in about ${plural(expiry, 'day')}</p>` : ''}</div>${admin ? `<button data-restore="${esc(i.id)}">Restore</button><button data-more="${esc(i.id)}" aria-label="Item actions">⋯</button>` : ''}</div>`;
            })
            .join('')}</section>`,
      )
      .join(
        '',
      )}${selecting ? `<div class="selection-bar"><b>${selection.count()} selected</b><button data-restore-selected ${busy ? 'disabled' : ''}>Restore</button><button data-delete-selected class="danger" ${busy ? 'disabled' : ''}>Delete forever</button></div>` : ''}`;
    document.body.classList.toggle('selecting', selecting);
    el.querySelectorAll('img').forEach(
      (i) =>
        (i.onerror = () => {
          i.hidden = true;
        }),
    );
    el.onchange = (e) => {
      if (busy || !e.target.dataset.id) return;
      e.target.checked
        ? selection.add([e.target.dataset.id])
        : selection.remove([e.target.dataset.id]);
      draw();
    };
    el.onclick = act(async (e) => {
      const b = e.target.closest('button');
      if (!b || busy) return;
      const has = (k) => b.hasAttribute('data-' + k);
      if (!admin && !has('reason')) return;
      if (has('select')) {
        selecting = !selecting;
        if (!selecting) selection.clear();
        draw();
      } else if (has('all')) {
        selection.add(visible.map((i) => i.id));
        draw();
      } else if (has('reason')) {
        reason = b.dataset.reason;
        selection.clear();
        draw();
      } else if (has('restore')) await run([b.dataset.restore], 'restore');
      else if (has('restore-all'))
        await run(
          items.map((i) => i.id),
          'restore',
        );
      else if (has('restore-selected')) await run(selection.ids(), 'restore');
      else if (has('delete-selected')) await run(selection.ids(), 'delete');
      else if (has('empty')) {
        await run(
          items.map((i) => i.id),
          'delete',
        );
      } else if (has('more')) {
        const box = document.createElement('section'),
          button = document.createElement('button');
        button.textContent = 'Delete forever';
        button.className = 'danger';
        box.append(button);
        const close = sheet(box, { anchor: b });
        button.onclick = act(async () => {
          close();
          await run([b.dataset.more], 'delete');
        });
      }
    });
  }
  const stopPress = longPress(el, '[data-bin-row]', (row) => {
    if (!admin || busy) return;
    selecting = true;
    selection.add([row.dataset.binRow]);
    draw();
  });
  const teardown = () => {
    stopped = true;
    cancel();
    unsubscribe();
    stopPress();
    if (el.isConnected) document.body.classList.remove('selecting');
    el.onclick = el.onchange = null;
  };
  ctx.scope.signal.addEventListener('abort', teardown, { once: true });
  await load();
  return teardown;
}

export const render = ownedRender(renderPage);
