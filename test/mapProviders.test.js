'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const providers = require('../src/shared/mapProviders.js');

test('OpenFreeMap is the default map, light by day and dark by night', () => {
  assert.equal(providers.DEFAULT_PROVIDER_ID, 'openfreemap');
  assert.equal(providers.getStyle('openfreemap'), 'https://tiles.openfreemap.org/styles/liberty');
  assert.equal(providers.getStyle('openfreemap', { dark: true }), 'https://tiles.openfreemap.org/styles/fiord');
});

test('ids saved before MapLibre (Google Maps, OpenStreetMap) open the default map', () => {
  for (const old of ['google', 'osm', undefined, null, 'nonsense']) {
    assert.equal(providers.getProvider(old).id, 'openfreemap', String(old));
  }
});

test('Google Satellite is an inline raster style, the same in light and dark', () => {
  const style = providers.getStyle('google-satellite', { dark: true });
  assert.equal(style.version, 8);
  const source = style.sources[providers.RASTER_SOURCE_ID];
  assert.equal(source.type, 'raster');
  assert.equal(source.tileSize, 256);
  assert.deepEqual(source.tiles, [0, 1, 2, 3].map((n) => `https://mt${n}.google.com/vt/lyrs=s&x={x}&y={y}&z={z}`));
  assert.deepEqual(style.layers, [{ id: providers.RASTER_SOURCE_ID, type: 'raster', source: providers.RASTER_SOURCE_ID }]);
  assert.ok(providers.isGoogleProvider('google-satellite'));
  assert.ok(!providers.isGoogleProvider('openfreemap'));
  // each call gets its own object (MapLibre keeps the style it is given)
  assert.notEqual(providers.getStyle('google-satellite'), style);
});

test('labels: place and road names only, none when labels are off; no 3D buildings; other layers always show', () => {
  const symbol = (sourceLayer) => ({ type: 'symbol', 'source-layer': sourceLayer });
  assert.ok(providers.isLayerVisible(symbol('place'), true));
  assert.ok(providers.isLayerVisible(symbol('transportation_name'), true));
  for (const hidden of ['poi', 'water_name', 'waterway', 'aerodrome_label', 'transportation', 'housenumber']) {
    assert.ok(!providers.isLayerVisible(symbol(hidden), true), hidden);
  }
  assert.ok(!providers.isLayerVisible(symbol('place'), false));
  assert.ok(!providers.isLayerVisible(symbol('transportation_name'), false));
  for (const type of ['line', 'fill', 'background', 'raster']) {
    assert.ok(providers.isLayerVisible({ type, 'source-layer': 'poi' }, false), type);
  }
  // a flat map: no 3D buildings
  assert.ok(!providers.isLayerVisible({ type: 'fill-extrusion', 'source-layer': 'building' }, true));
});

test('MapLibre is bundled with its worker and licence, and Leaflet is gone', () => {
  const vendor = path.join(__dirname, '../src/renderer/vendor');
  for (const file of ['maplibre-gl.mjs', 'maplibre-gl-worker.mjs', 'maplibre-gl.css', 'LICENSE.txt']) {
    assert.ok(fs.statSync(path.join(vendor, 'maplibre', file)).size > 0, file);
  }
  assert.match(fs.readFileSync(path.join(vendor, 'maplibre/maplibre-gl.mjs'), 'utf8').slice(0, 300), /MapLibre GL JS/);
  assert.ok(!fs.existsSync(path.join(vendor, 'leaflet')));
  const html = fs.readFileSync(path.join(__dirname, '../src/renderer/index.html'), 'utf8');
  assert.match(html, /href="vendor\/maplibre\/maplibre-gl\.css"/);
  assert.doesNotMatch(html, /leaflet\.(js|css)/);
});
