import { plural } from './format.js';
export function binNote(policy) {
  return policy?.enabled && Number(policy.binDays) > 0
    ? `Your cleanup rule deletes items for good ${plural(policy.binDays, 'day')} after they arrive here. Restore them before then.`
    : 'Nothing here is deleted until you empty the bin or press Delete forever. Restore puts footage back exactly where it was.';
}
export function expiresIn(item, policy, now = Date.now()) {
  return policy?.enabled && Number(policy.binDays) > 0 && Number.isFinite(Number(item.trashedAt))
    ? Math.max(
        0,
        Math.ceil((Number(item.trashedAt) + policy.binDays * 86400000 - Number(now)) / 86400000),
      )
    : null;
}

export function restoreResult(results) {
  const restored = results.reduce((n, r) => n + Number(r.restored || 0), 0);
  const conflicts = results.reduce((n, r) => n + Number(r.conflicts || 0), 0);
  return {
    text: `Restored ${plural(restored, 'file')}${conflicts ? `; ${conflicts} could not be restored (a file with that name exists)` : ''}.`,
    bad: conflicts > 0,
  };
}
