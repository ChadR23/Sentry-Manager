import { api, esc, sheet, act, scope } from '../core.js';
import { countText, ago } from '../format.js';
import { noteTone } from '../status.js';
import { icon } from '../icons.js';
export async function notifications(anchor, current = () => null) {
  const el = document.createElement('section');
  const close = sheet(el, { anchor });
  const flow = scope(() => [current()?.id], { alive: () => el.isConnected });
  const { api } = flow;
  flow.signal.addEventListener('abort', close, { once: true });
  async function draw() {
    const data = await api('/api/notifications');
    if (!el.isConnected) return;
    el.innerHTML =
      '<h2>Notifications</h2>' +
      (data.notifications || [])
        .map(
          (n) =>
            `<article class="health-check note-row"><span class="attention-icon ${n.resolvedAt ? '' : noteTone(n)}">${icon(n.resolvedAt ? 'info' : noteTone(n) === 'bad' ? 'error' : noteTone(n) === 'warn' ? 'warning' : 'info')}</span><div><h3>${esc(countText(globalThis.SentryUnits?.text?.(n.title) || n.title))}</h3><p>${esc(countText(globalThis.SentryUnits?.text?.(n.message) || n.message || ''))}</p><p>${ago(n.createdAt)}${n.resolvedAt ? ' · Resolved' : ''}</p>${!n.resolvedAt ? `<button data-dismiss="${esc(n.id)}">Dismiss</button>` : ''}</div></article>`,
        )
        .join('');
    if (!data.notifications?.length) el.innerHTML += '<p>Nothing needs you right now.</p>';
    const ids = data.notifications.filter((n) => !n.readAt).map((n) => n.id);
    if (ids.length) await api('/api/notifications/read', { body: { ids } });
  }
  el.onclick = act(async (e) => {
    const b = e.target.closest('[data-dismiss]');
    if (b) {
      await api('/api/notifications/' + b.dataset.dismiss + '/dismiss', {
        body: {},
      });
      await draw();
    }
  });
  await draw();
  return close;
}
