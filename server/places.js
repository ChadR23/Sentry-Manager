'use strict';

// Saved places (Home, Work): which place an event happened at, each place
// with its own radius (200 m for places saved before radii), and the spots
// where the car parks most, from the positions in Sentry and Saved events
// (Tesla's event.json est_lat / est_lon), for Settings > Places.

const DEFAULT_RADIUS = 200;
const MIN_RADIUS = 50;
const MAX_RADIUS = 2000;
// event spots closer than this to a suggestion's middle count towards it
const CLUSTER_M = 150;

/** Metres between two { lat, lon } (haversine). */
function metres(a, b) {
  const rad = Math.PI / 180;
  const s = Math.sin(((b.lat - a.lat) * rad) / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(((b.lon - a.lon) * rad) / 2) ** 2;
  return 2 * 6371000 * Math.asin(Math.min(1, Math.sqrt(s)));
}

/** A place's radius in metres: its own, else 200 m (places saved before radii). */
function radiusOf(place) {
  const r = Number(place?.radius);
  return Number.isFinite(r) && r >= MIN_RADIUS && r <= MAX_RADIUS ? r : DEFAULT_RADIUS;
}

/** A radius sent by the browser, in whole metres, or null when it is not 50 to 2000 m. */
function cleanRadius(v) {
  if (typeof v !== 'number' && !(typeof v === 'string' && /^\s*\d+(\.\d+)?\s*$/.test(v))) return null;
  const r = Math.round(Number(v));
  return Number.isFinite(r) && r >= MIN_RADIUS && r <= MAX_RADIUS ? r : null;
}

/** A latitude or longitude sent by the browser: a number (or a plain numeric string), else NaN. */
function coord(v) {
  if (typeof v === 'number') return v;
  if (typeof v === 'string' && /^\s*-?\d+(\.\d+)?\s*$/.test(v)) return Number(v);
  return NaN;
}

/** The saved place nearest to pos within that place's radius, or null. */
function placeOf(pos, places) {
  if (!pos || !Array.isArray(places)) return null;
  let best = null;
  for (const p of places) {
    if (!Number.isFinite(p?.lat) || !Number.isFinite(p?.lon)) continue;
    const m = metres(pos, p);
    if (m <= radiusOf(p) && (!best || m < best.m)) best = { place: p, m };
  }
  return best ? best.place : null;
}

/** The name of the saved place an event happened at, or null. */
function placeAt(pos, places) {
  return placeOf(pos, places)?.name ?? null;
}

const mostCommon = (values) => {
  const n = new Map();
  for (const v of values) if (v) n.set(v, (n.get(v) || 0) + 1);
  let best = null;
  for (const [v, c] of n) if (!best || c > best[1]) best = [v, c];
  return best ? best[0] : null;
};

/**
 * Where the car parks most: event spots ({ lat, lon, key, at, city, street,
 * vehicle }) grouped within 150 m of a group's middle, newest first, leaving
 * out spots inside a saved place's radius. Groups of at least `min` events,
 * most events first (then the most recent), at most `max` of them.
 */
function suggestPlaces(spots, places = [], { radius = CLUSTER_M, min = 2, max = 8 } = {}) {
  const groups = [];
  const sorted = spots.filter((s) => Number.isFinite(s?.lat) && Number.isFinite(s?.lon) && !placeOf(s, places))
    .sort((a, b) => String(b.key ?? '').localeCompare(String(a.key ?? '')));
  for (const s of sorted) {
    let best = null;
    for (const g of groups) {
      const m = metres(g, s);
      if (m <= radius && (!best || m < best.m)) best = { g, m };
    }
    if (best) {
      const g = best.g;
      g.members.push(s);
      // the middle follows the group (a running mean: groups are a few hundred metres at most)
      g.lat += (s.lat - g.lat) / g.members.length;
      g.lon += (s.lon - g.lon) / g.members.length;
    } else {
      groups.push({ lat: s.lat, lon: s.lon, members: [s] });
    }
  }
  return groups.filter((g) => g.members.length >= min)
    .sort((a, b) => b.members.length - a.members.length || String(b.members[0].key ?? '').localeCompare(String(a.members[0].key ?? '')))
    .slice(0, max)
    .map((g) => ({
      lat: Math.round(g.lat * 1e6) / 1e6,
      lon: Math.round(g.lon * 1e6) / 1e6,
      count: g.members.length,
      last: g.members[0].at ?? null,
      city: mostCommon(g.members.map((m) => m.city)),
      street: mostCommon(g.members.map((m) => m.street)),
      vehicles: [...new Set(g.members.map((m) => m.vehicle).filter(Boolean))]
    }));
}

/** How many of the spots are at each saved place: { [place id]: n }. */
function countAtPlaces(spots, places) {
  const out = Object.fromEntries(places.map((p) => [p.id, 0]));
  for (const s of spots) {
    const p = placeOf(s, places);
    if (p) out[p.id] += 1;
  }
  return out;
}

module.exports = { DEFAULT_RADIUS, MIN_RADIUS, MAX_RADIUS, CLUSTER_M, metres, radiusOf, cleanRadius, coord, placeOf, placeAt, suggestPlaces, countAtPlaces };
