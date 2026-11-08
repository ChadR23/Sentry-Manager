// Footage lengths, the same in the built-in interface and every interface pack
// (each pack has an identical copy of this file).
//
// footMinutes: whole minutes in days, hours and minutes, leaving out the parts
// that are zero: 59 -> "59 min", 120 -> "2 h", 731 -> "12 h 11 min",
// 1440 -> "1 day", 1500 -> "1 day 1 h", 16214 -> "11 days 6 h 14 min".
// trackLength: a recording's length as a clock: "3:00", or "12:11:00" from an
// hour on (hours keep counting past 24: "24:12:00").

export function footMinutes(min) {
  const m = Math.max(0, Math.round(Number(min) || 0));
  const days = Math.floor(m / 1440);
  const hours = Math.floor((m % 1440) / 60);
  const mins = m % 60;
  const parts = [];
  if (days) parts.push(`${days} ${days === 1 ? 'day' : 'days'}`);
  if (hours) parts.push(`${hours} h`);
  if (mins || !parts.length) parts.push(`${mins} min`);
  return parts.join(' ');
}

export function trackLength(sec) {
  const s = Math.max(0, Math.floor(Number(sec) || 0));
  const two = (n) => String(n).padStart(2, '0');
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h ? `${h}:${two(m)}:${two(s % 60)}` : `${m}:${two(s % 60)}`;
}
