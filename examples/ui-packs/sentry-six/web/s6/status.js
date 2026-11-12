import { countText, plural, dayKey as key, dayLabel as label, size as bytes } from './format.js';
export function strip(days = [], now = new Date(), length = 36) {
  const by = new Map(days.map((d) => [d.day, d]));
  return Array.from({ length }, (_, i) => {
    const date = new Date(now);
    date.setDate(date.getDate() - (length - 1 - i));
    const day = key(date),
      d = by.get(day);
    return {
      day,
      state:
        d?.archive?.state === 'filling'
          ? 'filling'
          : d?.recordings
            ? 'footage'
            : i === length - 1
              ? 'today'
              : 'none',
      drives: d?.byCategory?.Recent || 0,
      sentry: d?.byCategory?.Sentry || 0,
      saved: d?.byCategory?.Saved || 0,
      other: (d?.byCategory?.Sentry || 0) + (d?.byCategory?.Saved || 0),
    };
  });
}
export function attentionItems({
  vehicle,
  notes = [],
  checks = [],
  days = [],
  now = new Date(),
} = {}) {
  const out = [],
    vid = vehicle?.id;
  for (const n of notes) {
    if (n.kind === 'disk' || (n.vehicleId && n.vehicleId !== vid)) continue;
    out.push({
      kind: n.kind || 'notification',
      tone: ['critical', 'error'].includes(n.level || n.severity)
        ? 'bad'
        : ['warning', 'warn'].includes(n.level || n.severity)
          ? 'warn'
          : 'info',
      title: countText(n.title || 'Notification'),
      text: countText(n.message || n.text || ''),
      action: { label: 'View notification', href: '#/notifications' },
    });
  }
  for (const c of checks) {
    if (
      !['warn', 'bad', 'fail'].includes(c.status) ||
      (c.vehicleId && c.vehicleId !== vid) ||
      ['share-', 'write-', 'space-'].some(
        (prefix) => c.id?.startsWith(prefix) && c.id !== prefix + vid,
      ) ||
      c.kind === 'disk'
    )
      continue;
    const s = vehicle?.storage;
    out.push({
      kind: c.id,
      tone: ['bad', 'fail'].includes(c.status) ? 'bad' : 'warn',
      title:
        c.id === 'space-' + vid ? 'The share is almost full' : c.label || c.title || 'Health check',
      text:
        c.id === 'space-' + vid &&
        s &&
        Number.isFinite(s.free) &&
        s.total > 0 &&
        Number.isFinite(s.perDay)
          ? `${bytes(s.free)} free (${((100 * s.free) / s.total).toFixed(1)}%). Footage grows about ${bytes(s.perDay)} a day${s.daysLeft != null ? `, so it fills up in about ${plural(s.daysLeft, 'day')}` : ''}.`
          : c.hint || c.detail || '',
      action: {
        label: c.id === 'space-' + vid ? 'Free up space' : 'Open Health',
        href: c.id === 'space-' + vid ? '#/bin' : '#/health',
      },
    });
  }
  for (const d of days) {
    if (['partial', 'missing'].includes(d.archive?.state) && d.archive.summary)
      out.push({
        kind: 'archive',
        tone: 'warn',
        title: label(d.day, now),
        text: d.archive.summary,
        action: { label: 'Show day', href: '#/footage?from=' + d.day + '&to=' + d.day },
      });
  }
  const first = days.map((d) => d.day).sort()[0];
  const missing = strip(days, now).filter((c) => c.state === 'none' && first && c.day >= first);
  if (missing.length)
    out.push({
      kind: 'missing',
      tone: 'warn',
      title: `No footage on ${plural(missing.length, 'recent day')}`,
      text: `${missing.map((d) => label(d.day, now)).join(', ')}. If the car was driven then, its footage didn't reach the share.`,
      action: { label: 'Show days', href: '#/footage' },
    });
  return out.sort((a, b) => (a.tone === 'bad' ? 0 : 1) - (b.tone === 'bad' ? 0 : 1));
}
export function overviewStatus({
  vehicle,
  notes = [],
  checks = [],
  days = [],
  now = new Date(),
} = {}) {
  if (!vehicle)
    return { tone: 'ok', first: 'Add your first vehicle to get started.', second: '', sub: '' };
  const attention = attentionItems({ vehicle, notes, checks, days, now });
  let tone = attention[0]?.tone || 'ok',
    first = '',
    sub = '';
  const share = vehicle.share,
    inv = vehicle.inventory,
    previous = new Date(now);
  previous.setDate(previous.getDate() - 1);
  if (!share?.healthy) {
    first = "Can't reach your footage share.";
    tone = 'bad';
    sub = share?.lastError || 'The share has not been checked yet.';
  } else if (!share.writable) {
    first = 'Your footage is readable, but the share is read-only.';
    tone = 'warn';
  } else if (!inv?.lastDay) {
    first = 'Your share is ready. No footage has been found yet.';
  } else if (
    inv.lastDay >= key(previous) ||
    days.find((d) => d.day === inv.lastDay)?.archive?.state === 'filling'
  )
    first = 'Your footage is safe and up to date.';
  else first = 'Your footage is safe. The newest is from ' + label(inv.lastDay, now) + '.';
  const second = attention.length
    ? attention[0].kind === 'space-' + vehicle.id && vehicle.storage?.daysLeft != null
      ? `Space runs out in about ${plural(vehicle.storage.daysLeft, 'day')}.`
      : attention[0].title + '.'
    : 'Nothing needs you right now.';
  return { tone, first, second, sub };
}

export function healthSummary(checks = []) {
  const groups = new Map(),
    problems = checks.filter((c) => ['warn', 'fail', 'bad'].includes(c.status));
  for (const c of checks) {
    if (!groups.has(c.group)) groups.set(c.group, []);
    groups.get(c.group).push(c);
  }
  return {
    total: checks.length,
    passed: checks.filter((c) => c.status === 'ok').length,
    problems,
    groups: [...groups].map(([name, list]) => {
      const ok = list.filter((c) => c.status === 'ok').length,
        worst = list.some((c) => ['fail', 'bad'].includes(c.status))
          ? 'fail'
          : list.some((c) => c.status === 'warn')
            ? 'warn'
            : 'ok';
      return {
        name,
        ok,
        total: list.length,
        worst,
        line: ok === list.length ? `✓ All ${ok} passed` : `${ok} of ${list.length} passed`,
      };
    }),
  };
}
