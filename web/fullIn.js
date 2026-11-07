// "Days until full" in words, the same in every interface, from a vehicle's
// `storage` (GET /api/vehicles: free bytes, footage per day lately, daysLeft,
// capped = a policy deletes old footage of every kind).
//
//   const f = fullIn(v.storage);  // { text, short, tone: 'ok' | 'warn' | 'bad' } or null
//   (short: "12 days", "3 mo" for a tile)

export function fullIn(storage) {
  if (!storage || !Number.isFinite(storage.free)) return null;
  if (storage.capped) return { text: 'Policies keep it from filling', short: 'Never', tone: 'ok' };
  const d = storage.daysLeft;
  if (!Number.isFinite(d)) return { text: 'No new footage lately', short: '—', tone: 'ok' };
  const tone = d < 7 ? 'bad' : d < 30 ? 'warn' : 'ok';
  const long = d < 1 ? 'under a day' : d < 60 ? `${d} day${d === 1 ? '' : 's'}` : d < 730 ? `${Math.round(d / 30.4)} months` : `${Math.round(d / 365)} years`;
  const short = d < 1 ? '< 1 day' : d < 60 ? `${d} day${d === 1 ? '' : 's'}` : d < 730 ? `${Math.round(d / 30.4)} mo` : `${Math.round(d / 365)} yr`;
  return { text: `Full in about ${long} at this rate`, short, tone };
}
