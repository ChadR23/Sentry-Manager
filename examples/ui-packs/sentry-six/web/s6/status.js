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
/** How bad one notification is: 'bad' (critical), 'warn' (a warning) or '' (just news). */
export function noteTone(n = {}) {
  const level = n.level || n.severity;
  if (['critical', 'error'].includes(level)) return 'bad';
  if (['warning', 'warn'].includes(level) || (!level && n.kind === 'storage')) return 'warn';
  return '';
}
/** The bell's colour: the worst open notification, read or not. */
export function bellTone(notes = []) {
  const tones = notes.filter((n) => !n.resolvedAt).map(noteTone);
  return tones.includes('bad') ? 'bad' : tones.includes('warn') ? 'warn' : '';
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
  const relevant = (c) =>
    ['warn', 'bad', 'fail'].includes(c.status) &&
    (!c.vehicleId || c.vehicleId === vid) &&
    !['share-', 'write-', 'space-'].some(
      (prefix) => c.id?.startsWith(prefix) && c.id !== prefix + vid,
    ) &&
    c.kind !== 'disk';
  const problems = checks.filter(relevant);
  const mappedCheck = (n) => {
    if (n.kind === 'health' && n.dedupeKey?.startsWith('health:')) return n.dedupeKey.slice(7);
    const id = n.vehicleId || vid;
    if (n.kind === 'storage') return 'space-' + id;
    if (n.kind === 'share')
      return (
        (n.dedupeKey?.startsWith('readonly:') || /read.only/i.test(n.title) ? 'write-' : 'share-') +
        id
      );
    return problems.find((c) => c.kind === n.kind && c.vehicleId === n.vehicleId)?.id;
  };
  // as Original says it: days under two months, then months, then years
  const fillIn = (d) => (d < 1 ? 'under a day' : d < 60 ? plural(Math.round(d), 'day') : d < 730 ? `${Math.round(d / 30.4)} months` : `${Math.round(d / 365).toLocaleString()} years`);
  const storageText = (fallback = '') => {
    const s = vehicle?.storage;
    if (!s || !Number.isFinite(s.free) || !(s.total > 0)) return fallback;
    return (
      `${bytes(s.free)} free (${((100 * s.free) / s.total).toFixed(1)}%).` +
      (Number.isFinite(s.perDay)
        ? ` Footage grows about ${bytes(s.perDay)} a day${Number.isFinite(s.daysLeft) ? `, so it fills up in about ${fillIn(s.daysLeft)}` : ''}.`
        : '')
    );
  };
  for (const c of problems) {
    const storage = c.id === 'space-' + vid;
    out.push({
      kind: c.id,
      tone: ['bad', 'fail'].includes(c.status) ? 'bad' : 'warn',
      title: storage ? 'The share is almost full' : c.label || c.title || 'Health check',
      text: storage ? storageText(c.hint || c.detail || '') : c.hint || c.detail || '',
      action: {
        label: storage ? 'Free up space' : 'Open Health',
        href: storage ? '#/bin' : '#/health',
      },
    });
  }
  const seen = new Set(problems.map((c) => c.id));
  for (const n of notes) {
    if (n.kind === 'disk' || (n.vehicleId && n.vehicleId !== vid)) continue;
    const check = mappedCheck(n);
    if (
      check &&
      (seen.has(check) ||
        ['share-', 'write-', 'space-'].some(
          (prefix) => check.startsWith(prefix) && check !== prefix + vid,
        ))
    )
      continue;
    if (check) seen.add(check);
    const storage = n.kind === 'storage';
    out.push({
      kind: check || n.kind || 'notification',
      tone: ['critical', 'error'].includes(n.level || n.severity)
        ? 'bad'
        : storage || ['warning', 'warn'].includes(n.level || n.severity)
          ? 'warn'
          : 'info',
      title: storage ? 'The share is almost full' : countText(n.title || 'Notification'),
      text: storage ? storageText(n.message || n.text || '') : countText(n.message || n.text || ''),
      action: {
        label: storage ? 'Free up space' : 'View notification',
        href: storage ? '#/bin' : '#/notifications',
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
        action: {
          label: 'Show day',
          href: '#/footage?from=' + d.day + '&to=' + d.day,
        },
      });
  }
  const first = days.map((d) => d.day).sort()[0];
  const missing = strip(days, now).filter((c) => c.state === 'none' && first && c.day >= first);
  if (missing.length)
    out.push({
      kind: 'missing',
      tone: 'warn',
      title: `No footage on ${plural(missing.length, 'recent day')}`,
      text: `${missingDaySummary(missing.map((d) => d.day))}. If the car was driven then, its footage didn't reach the share.`,
      action: { label: 'Show days', href: '#/footage' },
    });
  return out.sort((a, b) => (a.tone === 'bad' ? 0 : 1) - (b.tone === 'bad' ? 0 : 1));
}
export function overviewStatus({
  vehicle,
  vehicleCount = 1,
  notes = [],
  checks = [],
  days = [],
  now = new Date(),
} = {}) {
  if (!vehicle)
    return {
      tone: 'ok',
      first: 'Add your first vehicle to get started.',
      second: '',
      sub: '',
    };
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
  let second = 'Nothing needs you right now.';
  if (attention.length) {
    if (attention[0].kind === 'space-' + vehicle.id) {
      second =
        vehicle.storage?.daysLeft != null
          ? `Space runs out in about ${plural(vehicle.storage.daysLeft, 'day')}.`
          : 'Space is running low.';
    } else {
      let title = attention[0].title;
      if (vehicleCount === 1 && vehicle.name && title.startsWith(vehicle.name + ': '))
        title = title.slice(vehicle.name.length + 2);
      second = title.replace(/[.!?]+$/, '') + '.';
    }
  }
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
        line:
          ok === list.length
            ? `✓ All ${ok.toLocaleString()} passed`
            : `${ok.toLocaleString()} of ${list.length.toLocaleString()} passed`,
      };
    }),
  };
}

// Collapse runs before limiting the list, so a week-long gap remains one readable range.
export function missingDaySummary(days = []) {
  const sorted = [...new Set(days)].sort(),
    ranges = [];
  for (const day of sorted) {
    const last = ranges.at(-1);
    if (last && new Date(day + 'T12:00:00Z') - new Date(last[1] + 'T12:00:00Z') === 86400000)
      last[1] = day;
    else ranges.push([day, day]);
  }
  const date = (day) =>
    new Date(day + 'T12:00:00Z').toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      timeZone: 'UTC',
      ...(sorted[0]?.slice(0, 4) !== sorted.at(-1)?.slice(0, 4) ? { year: 'numeric' } : {}),
    });
  const shown = ranges
    .slice(0, 3)
    .map(([a, b]) =>
      a === b
        ? date(a)
        : `${date(a)} – ${a.slice(0, 7) === b.slice(0, 7) ? Number(b.slice(8)) : date(b)}`,
    );
  const extra = ranges
    .slice(3)
    .reduce((n, [a, b]) => n + 1 + Math.round((new Date(b) - new Date(a)) / 86400000), 0);
  return (
    shown.map((s, i) => (i ? (i === shown.length - 1 ? ' and ' : ', ') : '') + s).join('') +
    (extra ? ` +${extra.toLocaleString()} more` : '')
  );
}

export function spaceTone(vehicle, checks = []) {
  const days = vehicle?.storage?.daysLeft;
  if (days != null && days < 14) return 'bad';
  if (
    (days != null && days <= 60) ||
    checks.some(
      (c) => c.id === 'space-' + vehicle?.id && ['warn', 'bad', 'fail'].includes(c.status),
    )
  )
    return 'warn';
  return 'ok';
}
