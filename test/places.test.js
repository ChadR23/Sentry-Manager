'use strict';

// Saved places (server/places.js and web/placesSettings.js): each place's
// radius (200 m for places saved before radii), where the car parks most
// (event spots grouped within 150 m, leaving out what a place covers), and
// coordinates pasted as maps apps copy them.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');
const P = require('../server/places');
const { viewerMay } = require('../server/accounts');

// metres north of a point (1 degree of latitude is about 111 195 m)
const north = (p, m) => ({ ...p, lat: p.lat + m / 111195 });
const east = (p, m) => ({ ...p, lon: p.lon + m / (111195 * Math.cos((p.lat * Math.PI) / 180)) });
const HOME = { lat: 41.8781, lon: -87.6298 };
const WORK = { lat: 41.9, lon: -87.7 };

test('placeAt: each place has its own radius; places saved before radii match within 200 m', () => {
  const old = [{ id: 'a', name: 'Home', lat: HOME.lat, lon: HOME.lon }];
  assert.equal(P.placeAt(north(HOME, 190), old), 'Home', 'an old place without a radius still matches at 190 m');
  assert.equal(P.placeAt(north(HOME, 215), old), null, 'and not past 200 m');
  const wide = [{ id: 'a', name: 'Home', lat: HOME.lat, lon: HOME.lon, radius: 600 }];
  assert.equal(P.placeAt(north(HOME, 550), wide), 'Home', 'a wider radius reaches further');
  const tight = [{ id: 'a', name: 'Home', lat: HOME.lat, lon: HOME.lon, radius: 50 }];
  assert.equal(P.placeAt(north(HOME, 80), tight), null, 'a tight one less far');
  // two places both in reach: the nearest wins
  const both = [{ id: 'a', name: 'Home', ...HOME, radius: 2000 }, { id: 'b', name: 'Shop', ...north(HOME, 300), radius: 200 }];
  assert.equal(P.placeAt(north(HOME, 280), both), 'Shop');
  assert.equal(P.placeAt(null, both), null);
  // a radius saved out of range counts as the default
  assert.equal(P.radiusOf({ radius: 99999 }), 200);
  assert.equal(P.radiusOf({}), 200);
  assert.equal(P.radiusOf({ radius: 750 }), 750);
});

test('radius and coordinates from the browser: 50 to 2000 m in whole metres; numbers only', () => {
  assert.equal(P.cleanRadius(200), 200);
  assert.equal(P.cleanRadius('350'), 350);
  assert.equal(P.cleanRadius(149.6), 150);
  assert.equal(P.cleanRadius(50), 50);
  assert.equal(P.cleanRadius(2000), 2000);
  for (const bad of [49, 2001, -100, 0, 'abc', '', null, undefined, NaN, Infinity, '1e3', [200], { r: 200 }, true]) assert.equal(P.cleanRadius(bad), null, String(bad));
  assert.equal(P.coord(41.5), 41.5);
  assert.equal(P.coord('-87.62'), -87.62);
  for (const bad of ['', ' ', null, undefined, '41.5 N', '0x10', true, [1], '1e2']) assert.ok(Number.isNaN(P.coord(bad)), String(bad));
});

test('where the car parks most: spots within 150 m are one suggestion, the most events first, saved places left out', () => {
  const spot = (p, key, extra = {}) => ({ ...p, key, at: key, city: 'Chicago', vehicle: 'Model Y', ...extra });
  const spots = [
    spot(HOME, '2026-11-07_20-00-00', { street: 'W Madison St' }),
    spot(north(HOME, 40), '2026-11-06_20-00-00', { street: 'W Madison St' }),
    spot(east(HOME, 90), '2026-11-05_20-00-00', { street: 'S State St' }),
    spot(north(HOME, -60), '2026-11-01_20-00-00', { street: 'W Madison St', vehicle: 'Model 3' }),
    spot(WORK, '2026-11-07_09-00-00', { street: 'N Elston Ave', city: 'Chicago' }),
    spot(north(WORK, 100), '2026-11-06_09-00-00', { street: 'N Elston Ave' }),
    // 400 m from Home: its own spot, only once (not a suggestion)
    spot(north(HOME, 400), '2026-11-02_10-00-00'),
    { lat: NaN, lon: 1, key: 'x' }
  ];
  const out = P.suggestPlaces(spots, []);
  assert.equal(out.length, 2, 'two places with two or more events; a single event is not a habit');
  assert.equal(out[0].count, 4);
  assert.equal(out[0].street, 'W Madison St', 'the street most of its events give');
  assert.equal(out[0].city, 'Chicago');
  assert.equal(out[0].last, '2026-11-07_20-00-00', 'the newest event there');
  assert.deepEqual(out[0].vehicles.sort(), ['Model 3', 'Model Y']);
  assert.ok(P.metres(out[0], HOME) < 60, 'the middle of its events');
  assert.equal(out[1].count, 2);
  assert.equal(out[1].street, 'N Elston Ave');
  assert.equal(String(out[0].lat).split('.')[1].length <= 6, true, '6 decimals at most');
  // with Home saved, its events are covered: only Work is left
  const saved = [{ id: 'h', name: 'Home', ...HOME }];
  const after = P.suggestPlaces(spots, saved);
  assert.equal(after.length, 1);
  assert.equal(after[0].street, 'N Elston Ave');
  // a tighter Home leaves the far events of that spot out of it, a wider one swallows the 400 m spot too
  assert.deepEqual(P.countAtPlaces(spots, saved), { h: 4 });
  assert.deepEqual(P.countAtPlaces(spots, [{ id: 'h', name: 'Home', ...HOME, radius: 50 }]), { h: 2 });
  assert.deepEqual(P.countAtPlaces(spots, [{ id: 'h', name: 'Home', ...HOME, radius: 500 }]), { h: 5 });
  // equal counts: the most recent first; and at most `max`
  const tie = P.suggestPlaces([spot(HOME, '1'), spot(HOME, '2'), spot(WORK, '3'), spot(WORK, '4')], []);
  assert.equal(tie[0].last, '4');
  assert.equal(P.suggestPlaces(spots, [], { max: 1 }).length, 1);
  assert.deepEqual(P.suggestPlaces([], []), []);
});

test('watch-only accounts: places read and written as before, and the suggestions read like the places', () => {
  assert.equal(viewerMay('GET', '/api/places'), true);
  assert.equal(viewerMay('GET', '/api/places/suggestions'), true, 'reading suggestions follows GET /api/places');
  assert.equal(viewerMay('POST', '/api/places'), true, 'the existing rule: places are like stars');
  assert.equal(viewerMay('PATCH', '/api/places/abc'), true);
  assert.equal(viewerMay('DELETE', '/api/places/abc'), true);
  assert.equal(viewerMay('POST', '/api/places/abc/more'), false, 'nothing under a place');
  assert.equal(viewerMay('PUT', '/api/settings/power'), false, 'other settings stay for admins');
});

// ---- the browser module's coordinate reader (as an .mjs copy: the package is CommonJS)
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'places-'));
const MODULE = path.join(TMP, 'placesSettings.mjs');
fs.copyFileSync(path.join(__dirname, '..', 'web', 'placesSettings.js'), MODULE);
test.after(() => fs.rmSync(TMP, { recursive: true, force: true }));

test('coordinates pasted as Google and Apple Maps copy them', async () => {
  const { parseCoords } = await import(pathToFileURL(MODULE).href);
  const chicago = { lat: 41.8781, lon: -87.6298 };
  for (const t of ['41.8781, -87.6298', '41.8781,-87.6298', '  41.8781 -87.6298 ', '41.8781° N, 87.6298° W', '41.8781°N 87.6298°W', '41.8781 N 87.6298 W',
    'N 41.8781, W 87.6298', 'N41.8781 W87.6298', '87.6298° W, 41.8781° N', '41,8781; -87,6298', '41.8781º N, 87.6298º W',
    'https://www.google.com/maps/place/Chicago/@41.8781,-87.6298,15z', 'https://maps.apple.com/?ll=41.8781,-87.6298&q=Dropped%20Pin', 'https://maps.google.com/?q=41.8781,-87.6298']) {
    assert.deepEqual(parseCoords(t), chicago, t);
  }
  // degrees, minutes and seconds (Google's "41°52'41.2"N 87°37'47.3"W")
  const dms = parseCoords('41°52\'41.2"N 87°37\'47.3"W');
  assert.ok(Math.abs(dms.lat - 41.878111) < 1e-6 && Math.abs(dms.lon + 87.629806) < 1e-6, JSON.stringify(dms));
  assert.deepEqual(parseCoords('41°52′41.2″N 87°37′47.3″W'), dms, 'with typographic primes');
  assert.deepEqual(parseCoords('33.8688° S, 151.2093° E'), { lat: -33.8688, lon: 151.2093 });
  assert.deepEqual(parseCoords('-33.86881234567, 151.2093'), { lat: -33.868812, lon: 151.2093 }, '6 decimals');
  for (const bad of ['', 'Home', '41.8781', '41.8781, -87.6298, 12', '91, 10', '10, 181', '41.8781 N, 87.6 N', '-41 S, 3 E', '0, 0', '41°75\'N 87°W', 'Chicago 41.8781, -87.6298', 'https://example.com/']) {
    assert.equal(parseCoords(bad), null, bad);
  }
});
