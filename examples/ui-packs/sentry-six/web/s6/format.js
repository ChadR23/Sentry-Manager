export function dayKey(date = new Date()) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}
export function dayLabel(day, now = new Date()) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day || '')) return 'Date unknown';
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  if (day === dayKey(now)) return 'Today';
  if (day === dayKey(yesterday)) return 'Yesterday';
  const d = new Date(day + 'T12:00:00');
  return d.toLocaleDateString('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    ...(d.getFullYear() !== now.getFullYear() ? { year: 'numeric' } : {}),
  });
}
export function timeLabel(at, h24 = false) {
  const d = typeof at === 'number' ? new Date(at) : null,
    m = d
      ? [null, d.getHours(), String(d.getMinutes()).padStart(2, '0')]
      : /(?:^|[ T_])(\d{1,2})[:-](\d{2})/.exec(at || '');
  if (!m) return 'Time unknown';
  const h = Number(m[1]);
  return h24
    ? `${String(h).padStart(2, '0')}:${m[2]}`
    : `${h % 12 || 12}:${m[2]} ${h < 12 ? 'AM' : 'PM'}`;
}
export function timeRange(a, b, h24 = false) {
  let x = timeLabel(a, h24),
    y = timeLabel(b, h24);
  if (!h24 && x.slice(-2) === y.slice(-2)) x = x.slice(0, -3);
  return `${x} – ${y}`;
}
export function duration(minutes) {
  if (!Number.isFinite(minutes)) return '—';
  const m = Math.max(0, Math.round(minutes)),
    h = Math.floor(m / 60);
  return `${h ? h.toLocaleString() + ' h ' : ''}${m % 60 || !h ? (m % 60) + ' min' : ''}`.trim();
}
export function size(bytes) {
  if (bytes == null || !Number.isFinite(Number(bytes))) return '—';
  let n = Number(bytes),
    i = 0;
  while (Math.abs(n) >= 1024 && i < 5) {
    n /= 1024;
    i++;
  }
  return `${i ? (Math.abs(n) >= 100 ? n.toFixed(0) : n.toFixed(1)) : Math.round(n)} ${['B', 'KB', 'MB', 'GB', 'TB', 'PB'][i]}`;
}
export function ago(ms, now = new Date()) {
  if (!ms) return 'not yet';
  const n = Math.max(0, (Number(now) - Number(ms)) / 60000);
  return n < 1
    ? 'just now'
    : n < 60
      ? `${plural(Math.round(n), 'minute')} ago`
      : n < 1440
        ? `${plural(Math.floor(n / 60), 'hour')} ago`
        : `${plural(Math.floor(n / 1440), 'day')} ago`;
}

export const plural = (n, one, many = one + 's') =>
  `${Number(n || 0).toLocaleString()} ${Number(n) === 1 ? one : many}`;
export function categoryEntries(categories = {}) {
  const order = ['Recent', 'Sentry', 'Saved'];
  return Object.entries(categories).sort(
    ([a], [b]) =>
      (order.includes(a) ? order.indexOf(a) : 3) - (order.includes(b) ? order.indexOf(b) : 3),
  );
}
export const categoryCount = (k, n) =>
  plural(
    n,
    k === 'Recent' ? 'drive' : k === 'Sentry' ? 'Sentry event' : k === 'Saved' ? 'saved' : k,
    k === 'Saved' ? 'saved' : undefined,
  );

/** Older server messages use "clip(s)"; present them with the same count rule. */
export const countText = (text) =>
  String(text ?? '')
    .replace(
      /\b(\d+) (drive|recording|Sentry event|item|file|clip|check|day)\(s\)/g,
      (_, n, noun) => plural(Number(n), noun),
    )
    .replace(
      /\b\d{4,}(?= (?:drives?|recordings?|Sentry events?|items?|files?|clips?|checks?|days?|logs?)\b)/g,
      (n) => Number(n).toLocaleString(),
    );
