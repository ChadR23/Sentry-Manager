/**
 * Map Visualization
 * Handles map marker updates and visibility.
 * Supports two orientation modes:
 *   - heading-up: arrow points up, map rotates (like car GPS)
 *   - north-up: map stays fixed north, arrow rotates to show heading
 *
 * MapLibre turns the map itself (its bearing), so the arrow marker is aligned
 * to the map: with rotation = heading it points up in heading-up mode and
 * along the heading in north-up mode. Pins and dots are aligned to the
 * viewport, so they stay upright either way.
 */

import { htmlMarker, toLngLat, toRasterZoom, fitTo, centreOn } from './mapGl.js';

// Map state
let mapMarker = null;
let mapMarkerArrowImg = null; // Cached arrow <img> inside the marker
let currentMapBearing = 0; // Smoothed heading (unwrapped degrees)
let zoomListenerAttached = false;
// Last rendered position/bearing/size: updateMapMarker runs at 60Hz, and
// camera and marker writes are wasted work while the vehicle sits still
// (most Sentry footage)
let lastMarkerFrameKey = null;

// Orientation mode: 'heading-up' or 'north-up'
let mapOrientation = 'heading-up';

/**
 * Get current map orientation mode
 * @returns {'heading-up'|'north-up'}
 */
export function getMapOrientation() {
    return mapOrientation;
}

/**
 * Set map orientation mode
 * @param {'heading-up'|'north-up'} mode
 */
export function setMapOrientation(mode) {
    mapOrientation = mode;
    lastMarkerFrameKey = null;
    const map = getMap?.();
    if (!map) return;
    map.easeTo({ bearing: mode === 'heading-up' ? currentMapBearing : 0, duration: 300 });
}

/**
 * Calculate arrow icon size based on map zoom level (a raster zoom level).
 * Uses a gentle linear scale so the arrow stays visible even when zoomed out.
 * Zoom 16+ → 80px, zoom 12 → ~48px, zoom 8 → ~28px
 */
function getArrowSizeForZoom(zoom) {
    const size = 28 + (zoom - 8) * 6.5;
    return Math.max(28, Math.min(120, Math.round(size)));
}

function arrowSizeFor(map) {
    return getArrowSizeForZoom(toRasterZoom(map.getZoom()));
}

function sizeArrow(size) {
    if (!mapMarkerArrowImg) return;
    mapMarkerArrowImg.style.width = `${size}px`;
    mapMarkerArrowImg.style.height = `${size}px`;
}

// Dependencies set via init
let getMap = null;
let getMapVis = null;
let getMapPolyline = null;
let getState = null;

/**
 * Initialize map visualization module with dependencies
 * @param {Object} deps - Dependencies
 */
export function initMapVisualization(deps) {
    getMap = deps.getMap;
    getMapVis = deps.getMapVis;
    getMapPolyline = deps.getMapPolyline;
    getState = deps.getState;
}

/**
 * Update map visibility based on user toggle
 */
export function updateMapVisibility() {
    const mapVis = getMapVis?.();
    const map = getMap?.();
    const mapPolyline = getMapPolyline?.();
    const state = getState?.();

    if (!mapVis) return;
    const enabled = !!state?.ui?.mapEnabled &&
        state?.library?.capabilities?.map !== false;
    mapVis.classList.toggle('user-hidden', !enabled);

    if (enabled && map) {
        setTimeout(() => {
            map.resize();
            const bounds = mapPolyline?.getBounds?.();
            if (bounds) fitTo(map, bounds, { padding: 20 });
            else if (mapMarker) centreOn(map, window._mapCurrentMarkerLatLng, 16);
        }, 150);
    }
}

/**
 * Update map marker position and heading
 * @param {Object} sei - SEI telemetry data
 * @param {Function} hasValidGps - Function to check if GPS is valid
 */
export function updateMapMarker(sei, hasValidGps) {
    const map = getMap?.();

    if (!map || !sei) return;

    const get = (camel, snake) => sei[camel] ?? sei[snake];
    const lat = get('latitudeDeg', 'latitude_deg') || 0;
    const lon = get('longitudeDeg', 'longitude_deg') || 0;
    const heading = get('headingDeg', 'heading_deg') || 0;

    if (hasValidGps(sei)) {
        const latlng = [lat, lon];

        if (Math.abs(lat) < 0.001 || Math.abs(lon) < 0.001) {
            clearArrow();
            return;
        }

        const targetHeading = ((heading % 360) + 360) % 360;

        // Take the short way round to the new heading
        let bearingDelta = targetHeading - (currentMapBearing % 360);
        if (bearingDelta > 180) bearingDelta -= 360;
        if (bearingDelta < -180) bearingDelta += 360;
        currentMapBearing += bearingDelta;

        // Attach zoom listener once to rescale arrow on zoom change
        if (!zoomListenerAttached) {
            map.on('zoom', () => sizeArrow(arrowSizeFor(map)));
            zoomListenerAttached = true;
        }

        const arrowSize = arrowSizeFor(map);

        // Nothing visibly changed since last frame: skip all map/DOM work
        const frameKey = `${lat.toFixed(6)},${lon.toFixed(6)},${currentMapBearing.toFixed(1)},${arrowSize},${mapOrientation}`;
        if (mapMarker && frameKey === lastMarkerFrameKey) return;
        lastMarkerFrameKey = frameKey;

        if (!mapMarker) {
            mapMarker = htmlMarker(map, latlng, {
                className: 'arrow-marker-icon',
                html: `<img src="../../assets/arrow.png" alt="" style="width:${arrowSize}px;height:${arrowSize}px;display:block;" />`,
                rotationAlignment: 'map'
            });
            mapMarkerArrowImg = mapMarker.getElement().querySelector('img');
        } else {
            mapMarker.setLngLat(toLngLat(latlng));
            sizeArrow(arrowSize);
        }
        mapMarker.setRotation(currentMapBearing);

        // Store for recenter button
        window._mapCurrentMarkerLatLng = latlng;

        // Update compass icon rotation
        if (window._updateMapCompass) {
            window._updateMapCompass(currentMapBearing);
        }

        // Follow the car; in heading-up mode the map turns under the arrow
        centreOn(map, latlng, undefined, {
            bearing: mapOrientation === 'heading-up' ? currentMapBearing : 0
        });
    } else {
        clearArrow();
    }
}

function clearArrow() {
    if (mapMarker) {
        mapMarker.remove();
        mapMarker = null;
    }
    mapMarkerArrowImg = null;
    lastMarkerFrameKey = null;
}

/**
 * Clear map marker
 */
export function clearMapMarker() {
    clearArrow();
    currentMapBearing = 0;
    window._mapCurrentMarkerLatLng = null;

    // Back to north up
    const map = getMap?.();
    if (map) map.easeTo({ bearing: 0, duration: 300 });
}
