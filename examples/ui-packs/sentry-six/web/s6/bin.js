export function binNote(policy) {
  return policy?.enabled && Number(policy.binDays) > 0
    ? `Your cleanup rule deletes items for good ${policy.binDays} days after they arrive here. Restore them before then.`
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
