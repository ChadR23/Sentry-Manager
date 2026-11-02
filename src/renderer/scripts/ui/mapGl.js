/**
 * MapLibre GL helpers shared by every map in this window (the Viewer map and
 * the Advanced Editor minimap preview).
 *
 * - Coordinates: the app's telemetry is [lat, lon] (or {lat, lon}); MapLibre
 *   takes [lng, lat]. Everything here takes the app's order and converts.
 * - Zoom: MapLibre's zoom levels are one less than the 256 px raster levels
 *   the Viewer's numbers were tuned on (16 there is 15 here), so callers give
 *   raster levels and toGlZoom() converts.
 * - Overlays (the route, the preview's path): MapLibre drops a map's sources
 *   and layers when its style changes (light / dark / satellite), so the app's
 *   own ones are kept here and added again on every 'style.load'. HTML
 *   markers are DOM elements and survive a style change on their own.
 */

import * as maplibregl from '../../vendor/maplibre/maplibre-gl.mjs';

export { maplibregl };

const ZOOM_OFFSET = 1;

/** Raster (Leaflet) zoom level → MapLibre zoom level. */
export function toGlZoom(rasterZoom) {
    return rasterZoom - ZOOM_OFFSET;
}

/** MapLibre zoom level → raster (Leaflet) zoom level. */
export function toRasterZoom(glZoom) {
    return glZoom + ZOOM_OFFSET;
}

/** [lat, lon] or {lat, lon|lng} → [lng, lat]. */
export function toLngLat(p) {
    if (Array.isArray(p)) return [p[1], p[0]];
    return [p.lon ?? p.lng, p.lat];
}

// Shown until the provider's real style has loaded, so the map draws its
// background instead of nothing while the settings and style are fetched.
const EMPTY_STYLE = { version: 8, sources: {}, layers: [] };

// Map -> Map<overlayId, { source, layers }>
const overlaysByMap = new WeakMap();

/**
 * Create a map in `container` with the app's interaction rules: no left-drag
 * pan (left drag moves the floating panel), no rotate or pitch gestures (the
 * app sets the bearing itself in heading-up mode), no keyboard or box zoom.
 *
 * @param {HTMLElement|string} container
 * @param {Object} [opts]
 * @param {boolean} [opts.scrollZoom=true]
 * @param {boolean} [opts.doubleClickZoom=true]
 * @param {boolean} [opts.touchZoom=true]
 * @param {boolean} [opts.dragPan=false] left-drag / one-finger pan (the
 *   interface packs' maps, which sit in the page rather than a floating panel)
 * @param {boolean} [opts.attribution=true] compact attribution button
 * @param {number} [opts.maxZoom] raster zoom ceiling
 * @returns {maplibregl.Map}
 */
export function createMap(container, opts = {}) {
    const map = new maplibregl.Map({
        container,
        style: EMPTY_STYLE,
        center: [0, 0],
        zoom: toGlZoom(2),
        ...(opts.maxZoom !== undefined ? { maxZoom: toGlZoom(opts.maxZoom) } : {}),
        maxPitch: 0,
        attributionControl: false,
        dragPan: opts.dragPan === true,
        dragRotate: false,
        keyboard: false,
        boxZoom: false,
        pitchWithRotate: false,
        touchPitch: false,
        scrollZoom: opts.scrollZoom !== false,
        doubleClickZoom: opts.doubleClickZoom !== false,
        touchZoomRotate: opts.touchZoom !== false,
        cooperativeGestures: false
    });
    // Map data credits (OpenStreetMap's licence asks for them): the small
    // (i) button, bottom left, clear of the panel's own buttons on the right.
    if (opts.attribution !== false) {
        map.addControl(new maplibregl.AttributionControl({ compact: true }), 'bottom-left');
    }
    // Pinch zooms but never rotates: the bearing is the app's to set.
    if (opts.touchZoom !== false) map.touchZoomRotate.disableRotation();
    overlaysByMap.set(map, new Map());
    map.on('style.load', () => addOverlays(map));
    // The panel is shown, hidden and resized by the app (and starts hidden),
    // so follow the container's size, not just the window's; a fit asked for
    // while the map had no size is done once it has one.
    if (typeof ResizeObserver !== 'undefined') {
        const observer = new ResizeObserver(() => {
            map.resize();
            const pending = pendingFits.get(map);
            if (pending && hasSize(map)) {
                pendingFits.delete(map);
                fitTo(map, pending.bounds, pending.opts);
            }
        });
        observer.observe(map.getContainer());
        map.once('remove', () => observer.disconnect());
    }
    // The compact credits stay folded into their (i) button: MapLibre opens
    // them whenever a style brings new credits (every light / dark /
    // satellite swap); a tap on (i) still opens them.
    const foldCredits = () => {
        const el = map.getContainer().querySelector('.maplibregl-ctrl-attrib.maplibregl-compact');
        if (!el) return;
        el.classList.remove('maplibregl-compact-show');
        el.removeAttribute('open');
    };
    map.on('styledata', foldCredits);
    map.on('sourcedata', e => { if (e.sourceDataType === 'metadata') foldCredits(); });
    return map;
}

// Map -> { bounds, opts } waiting for the map to have a size
const pendingFits = new WeakMap();

function hasSize(map) {
    const el = map.getContainer();
    return el.clientWidth > 0 && el.clientHeight > 0;
}

// The style itself has loaded (sources may still be fetching tiles, which
// map.isStyleLoaded() also waits for). Sources and layers can be added now.
function styleReady(map) {
    return !!(map.style && map.style._loaded);
}

function addOverlays(map) {
    const overlays = overlaysByMap.get(map);
    if (!overlays) return;
    for (const [id, overlay] of overlays) addOverlay(map, id, overlay);
}

function addOverlay(map, id, overlay) {
    try {
        if (!map.getSource(id)) map.addSource(id, overlay.source);
        for (const layer of overlay.layers) {
            if (!map.getLayer(layer.id)) map.addLayer({ ...layer, source: id });
        }
    } catch (err) {
        console.warn('[MAP] Failed to add overlay', id, err);
    }
}

function dropOverlay(map, id, overlay) {
    try {
        for (const layer of overlay.layers) {
            if (map.getLayer(layer.id)) map.removeLayer(layer.id);
        }
        if (map.getSource(id)) map.removeSource(id);
    } catch { /* style mid-swap: it is gone already */ }
}

/**
 * Show (or replace) one of the app's own overlays. Its ids must start with
 * "sx-" so the label rule never touches it.
 * @param {maplibregl.Map} map
 * @param {string} id - source id
 * @param {{source: Object, layers: Object[]}} overlay - layers without `source`
 */
export function setOverlay(map, id, overlay) {
    const overlays = overlaysByMap.get(map);
    if (!overlays) return;
    const old = overlays.get(id);
    overlays.set(id, overlay);
    if (!styleReady(map)) return; // 'style.load' adds it
    const source = map.getSource(id);
    const sameLayers = old && old.layers.length === overlay.layers.length &&
        old.layers.every((l, i) => l.id === overlay.layers[i].id);
    if (source && sameLayers && overlay.source.type === 'geojson' && source.setData) {
        source.setData(overlay.source.data);
        return;
    }
    if (old) dropOverlay(map, id, old);
    addOverlay(map, id, overlay);
}

/** Remove one of the app's overlays. */
export function removeOverlay(map, id) {
    const overlays = overlaysByMap.get(map);
    const old = overlays?.get(id);
    if (!old) return;
    overlays.delete(id);
    dropOverlay(map, id, old);
}

/**
 * Bounds around points given as [lat, lon] or {lat, lon}.
 * @returns {maplibregl.LngLatBounds|null}
 */
export function boundsOf(points) {
    let bounds = null;
    for (const p of points || []) {
        const ll = toLngLat(p);
        if (!Number.isFinite(ll[0]) || !Number.isFinite(ll[1])) continue;
        if (!bounds) bounds = new maplibregl.LngLatBounds(ll, ll);
        else bounds.extend(ll);
    }
    return bounds;
}

/**
 * Fit bounds, keeping the current bearing (MapLibre's own fitBounds turns
 * north up unless told otherwise).
 * @param {maplibregl.Map} map
 * @param {maplibregl.LngLatBounds} bounds
 * @param {{padding?: number, maxZoom?: number, animate?: boolean}} [opts]
 *   maxZoom is a raster level; without animate the camera jumps at once.
 */
export function fitTo(map, bounds, opts = {}) {
    if (!map || !bounds) return;
    if (!hasSize(map)) {
        pendingFits.set(map, { bounds, opts });
        return;
    }
    pendingFits.delete(map);
    const el = map.getContainer();
    // Padding that would leave no room is dropped (a tiny panel)
    let padding = opts.padding ?? 20;
    if (el.clientWidth <= padding * 2 + 1 || el.clientHeight <= padding * 2 + 1) padding = 0;
    try {
        // (an option given as undefined overrides MapLibre's default with
        // undefined, so maxZoom is only passed when there is one)
        const options = { padding, bearing: map.getBearing(), duration: opts.animate ? 500 : 0 };
        if (opts.maxZoom !== undefined) options.maxZoom = toGlZoom(opts.maxZoom);
        map.fitBounds(bounds, options);
    } catch (err) {
        console.warn('[MAP] Could not fit the route:', err);
    }
}

/**
 * Centre on a point at a raster zoom level.
 * @param {maplibregl.Map} map
 * @param {[number, number]|{lat:number, lon:number}} point
 * @param {number} [rasterZoom] - keeps the current zoom when left out
 * @param {{animate?: boolean, bearing?: number}} [opts]
 */
export function centreOn(map, point, rasterZoom, opts = {}) {
    if (!map || !point) return;
    const camera = { center: toLngLat(point) };
    if (rasterZoom !== undefined) camera.zoom = toGlZoom(rasterZoom);
    if (opts.bearing !== undefined) camera.bearing = opts.bearing;
    if (opts.animate) map.easeTo({ ...camera, duration: 500 });
    else map.jumpTo(camera);
}

/**
 * An HTML marker at [lat, lon].
 * @param {maplibregl.Map} map
 * @param {[number, number]} point
 * @param {Object} opts
 * @param {string} opts.html - the marker's inner markup
 * @param {string} [opts.className]
 * @param {'center'|'bottom'} [opts.anchor='center']
 * @param {'map'|'viewport'} [opts.rotationAlignment='viewport'] - 'map' turns
 *   with the map (the heading arrow), 'viewport' stays upright (pins, dots)
 * @param {string} [opts.title] - native tooltip
 * @returns {maplibregl.Marker}
 */
export function htmlMarker(map, point, opts) {
    const el = document.createElement('div');
    if (opts.className) el.className = opts.className;
    if (opts.title) el.title = opts.title;
    el.innerHTML = opts.html;
    return new maplibregl.Marker({
        element: el,
        anchor: opts.anchor || 'center',
        rotationAlignment: opts.rotationAlignment || 'viewport',
        pitchAlignment: 'viewport'
    }).setLngLat(toLngLat(point)).addTo(map);
}

/**
 * Draw a route as coloured line segments.
 * @param {maplibregl.Map} map
 * @param {string} id - overlay id, starting with "sx-"
 * @param {{coords: Array<[number, number]>, color: string}[]} segments
 *   coords in [lat, lon]
 * @param {{width?: number}} [opts]
 * @returns {{remove: Function, getBounds: Function}} handle
 */
export function drawRoute(map, id, segments, opts = {}) {
    const all = [];
    const features = segments
        .filter(seg => seg.coords.length > 1)
        .map(seg => {
            const coordinates = seg.coords.map(toLngLat);
            all.push(...seg.coords);
            return {
                type: 'Feature',
                properties: { color: seg.color },
                geometry: { type: 'LineString', coordinates }
            };
        });
    setOverlay(map, id, {
        source: { type: 'geojson', data: { type: 'FeatureCollection', features } },
        layers: [{
            id: `${id}-line`,
            type: 'line',
            layout: { 'line-join': 'round', 'line-cap': 'round' },
            paint: { 'line-color': ['get', 'color'], 'line-width': opts.width ?? 4 }
        }]
    });
    const bounds = boundsOf(all);
    return {
        remove: () => removeOverlay(map, id),
        getBounds: () => bounds
    };
}
