import { api, esc, sheet, act } from '../core.js';
import { countText, ago } from '../format.js';
export async function notifications(anchor) {
  const el = document.createElement('section');
  const close = sheet(el, { anchor });
  async function draw() {
    const data = await api('/api/notifications');
    if (!el.isConnected) return;
    el.innerHTML =
      '<h2>Notifications</h2>' +
      (data.notifications || [])
        .map(
          (n) =>
            `<article class="health-check"><h3>${esc(countText(globalThis.SentryUnits?.text?.(n.title) || n.title))}</h3><p>${esc(countText(globalThis.SentryUnits?.text?.(n.message) || n.message || ''))}</p><p>${ago(n.createdAt)}${n.resolvedAt ? ' · Resolved' : ''}</p>${!n.resolvedAt ? `<button data-dismiss="${esc(n.id)}">Dismiss</button>` : ''}</article>`,
        )
        .join('');
    if (!data.notifications?.length) el.innerHTML += '<p>Nothing needs you right now.</p>';
    const ids = data.notifications.filter((n) => !n.readAt).map((n) => n.id);
    if (ids.length) await api('/api/notifications/read', { body: { ids } });
  }
  el.onclick = act(async (e) => {
    const b = e.target.closest('[data-dismiss]');
    if (b) {
      await api('/api/notifications/' + b.dataset.dismiss + '/dismiss', { body: {} });
      await draw();
    }
  });
  await draw();
  return close;
}
