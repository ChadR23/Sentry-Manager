/**
 * Map provider registry: the single source of truth for every MapLibre GL
 * map in the app (the Viewer map and the Advanced Editor minimap preview).
 *
 * Loaded as a classic <script> in index.html, where it exposes
 * `window.MapProviders` (classic scripts run before ES modules, so module
 * code can rely on the global), and via require() in Node for tests.
 *
 * Providers:
 *  - 'openfreemap' (default): OpenFreeMap's free vector maps (no key, no
 *    sign-up), "liberty" by day and the blue-grey "fiord" by night. Both use the
 *    OpenMapTiles schema, so the label rule below works on either.
 *  - 'google-satellite': Google's public satellite tiles (the key-less
 *    mt{n}.google.com endpoint Sentry Drive uses, NOT the Google Maps JS
 *    API). That endpoint is unofficial, so the Viewer falls back to
 *    OpenFreeMap for the session when its tiles stop loading.
 *
 * Saved ids from the Leaflet days ('google', 'osm') resolve to the default.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  }
  if (root && typeof root === 'object') {
    root.MapProviders = api;
  }
})(typeof self !== 'undefined' ? self : this, function () {
  const OPENFREEMAP = 'https://tiles.openfreemap.org';

  const PROVIDERS = {
    'openfreemap': {
      id: 'openfreemap',
      label: 'OpenFreeMap',
      vector: true,
      styles: {
        light: OPENFREEMAP + '/styles/liberty',
        dark: OPENFREEMAP + '/styles/fiord'
      }
    },
    'google-satellite': {
      id: 'google-satellite',
      label: 'Google Satellite',
      photographic: true,
      tiles: ['mt0', 'mt1', 'mt2', 'mt3'].map(function (s) {
        return 'https://' + s + '.google.com/vt/lyrs=s&x={x}&y={y}&z={z}';
      }),
      maxzoom: 20,
      attribution: '&copy; Google'
    }
  };

  const DEFAULT_PROVIDER_ID = 'openfreemap';
  const FALLBACK_PROVIDER_ID = 'openfreemap';

  // Settings key + default for the map-labels toggle (Settings → Map → "Map
  // Labels").
  const LABELS_SETTING_KEY = 'mapLabels';
  const DEFAULT_LABELS_ENABLED = true;

  // Labels are curated, not all-or-nothing (as on Sentry Drive's map): only
  // place names (cities, neighbourhoods) and road names and shields show;
  // points of interest, water names, airports and one-way arrows stay off.
  // With labels off, no symbol layer shows at all.
  const CURATED_LABEL_SOURCE_LAYERS = ['place', 'transportation_name'];

  // Known-good tile used to cheaply test whether Google tiles are reachable.
  const GOOGLE_PROBE_URL = 'https://mt1.google.com/vt/lyrs=s&x=0&y=0&z=0';

  // The source id of a raster provider's tiles inside its style, so error
  // events can be told apart from the app's own route and marker sources.
  const RASTER_SOURCE_ID = 'provider-raster';

  function getProvider(id) {
    return PROVIDERS[id] || PROVIDERS[DEFAULT_PROVIDER_ID];
  }

  function isGoogleProvider(id) {
    return getProvider(id).id.indexOf('google') === 0;
  }

  /**
   * The MapLibre style for a provider: a style URL for vector providers,
   * a small inline raster style for imagery.
   * @param {string} id - Provider id
   * @param {{dark?: boolean}} [opts]
   * @returns {string|Object} style URL or style object
   */
  function getStyle(id, opts) {
    const p = getProvider(id);
    if (p.vector) return (opts && opts.dark) ? p.styles.dark : p.styles.light;
    const sources = {};
    sources[RASTER_SOURCE_ID] = {
      type: 'raster',
      tiles: p.tiles.slice(),
      tileSize: 256,
      maxzoom: p.maxzoom,
      attribution: p.attribution
    };
    return {
      version: 8,
      sources: sources,
      layers: [{ id: RASTER_SOURCE_ID, type: 'raster', source: RASTER_SOURCE_ID }]
    };
  }

  /**
   * Whether a style layer should be visible under the label setting. Symbol
   * layers follow it; 3D buildings never show; lines, fills and imagery do.
   * @param {{type: string, 'source-layer'?: string}} layer
   * @param {boolean} labelsEnabled
   * @returns {boolean}
   */
  function isLayerVisible(layer, labelsEnabled) {
    if (!layer) return true;
    // A flat map, as before: 3D buildings show their walls towards the
    // panel's edges even looking straight down.
    if (layer.type === 'fill-extrusion') return false;
    if (layer.type !== 'symbol') return true;
    if (!labelsEnabled) return false;
    return CURATED_LABEL_SOURCE_LAYERS.indexOf(layer['source-layer']) !== -1;
  }

  return {
    PROVIDERS,
    DEFAULT_PROVIDER_ID,
    FALLBACK_PROVIDER_ID,
    LABELS_SETTING_KEY,
    DEFAULT_LABELS_ENABLED,
    GOOGLE_PROBE_URL,
    RASTER_SOURCE_ID,
    getProvider,
    isGoogleProvider,
    getStyle,
    isLayerVisible
  };
});
