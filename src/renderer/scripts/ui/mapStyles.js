/**
 * Map Styles Manager
 *
 * Owns which provider every MapLibre map in this window shows (the Viewer
 * map and the Advanced Editor minimap preview), in light or dark and with or
 * without labels. Providers come from the shared registry in
 * src/shared/mapProviders.js (window.MapProviders): OpenFreeMap's vector maps
 * by default, Google Satellite on request.
 *
 * Fallback: when Google Satellite is chosen and Google's tile servers turn
 * out to be unreachable (probe failure, or repeated tile errors before the
 * first tile loads), the session falls back to OpenFreeMap on every
 * registered map and shows a toast. The saved setting is left untouched, so
 * the next visit tries Google again.
 */

import { notify } from './notifications.js';
import { t } from '../lib/i18n.js';

const SETTING_KEY = 'mapTileProvider';

// Maps registered for live style swapping: Map<maplibregl.Map, {providerId, dark}>
const registeredMaps = new Map();

let selectedProviderId = null;   // resolved from settings (null until loaded)
let labelsEnabled = null;        // resolved from settings (null until loaded)
let sessionFallbackActive = false;
let settingLoadPromise = null;
let probeStarted = false;

// Tile error accounting for the "errors before first success" rule
let googleTileErrors = 0;
let googleTileLoaded = false;

function registry() {
    return window.MapProviders;
}

function loadSelectedProvider() {
    if (!settingLoadPromise) {
        settingLoadPromise = (async () => {
            try {
                const saved = await window.electronAPI?.getSetting?.(SETTING_KEY);
                selectedProviderId = registry().getProvider(saved).id;
            } catch {
                selectedProviderId = registry().DEFAULT_PROVIDER_ID;
            }
            try {
                const savedLabels = await window.electronAPI?.getSetting?.(registry().LABELS_SETTING_KEY);
                labelsEnabled = (savedLabels === undefined || savedLabels === null)
                    ? registry().DEFAULT_LABELS_ENABLED
                    : !!savedLabels;
            } catch {
                labelsEnabled = registry().DEFAULT_LABELS_ENABLED;
            }
            // Start in the saved light/dark style rather than swapping to it
            // when script.js reads the same setting a moment later.
            try {
                if (await window.electronAPI?.getSetting?.('mapDarkMode') === true) window._mapDarkMode = true;
            } catch { /* light */ }
            return selectedProviderId;
        })();
    }
    return settingLoadPromise;
}

/** Whether map labels are currently enabled (resolved setting, or default). */
export function getMapLabelsEnabled() {
    return labelsEnabled === null ? registry().DEFAULT_LABELS_ENABLED : labelsEnabled;
}

/**
 * Toggle map labels: persist, then show or hide the label layers on every
 * live map (no style reload needed).
 * @param {boolean} enabled
 */
export async function setMapLabels(enabled) {
    labelsEnabled = !!enabled;
    try {
        await window.electronAPI?.setSetting?.(registry().LABELS_SETTING_KEY, labelsEnabled);
    } catch (err) {
        console.warn('[MAP] Failed to persist map labels setting:', err);
    }
    for (const map of registeredMaps.keys()) applyLabels(map);
}

export function getEffectiveProviderId() {
    const selected = selectedProviderId || registry().DEFAULT_PROVIDER_ID;
    return sessionFallbackActive && registry().isGoogleProvider(selected)
        ? registry().FALLBACK_PROVIDER_ID
        : selected;
}

export function getSelectedProviderId() {
    return selectedProviderId || registry().DEFAULT_PROVIDER_ID;
}

function isDark() {
    return !!(typeof window !== 'undefined' && window._mapDarkMode);
}

// Show or hide the style's label layers by the label setting. The app's own
// layers ("sx-…") are never touched.
function applyLabels(map) {
    let layers;
    try { layers = map.getStyle()?.layers || []; } catch { return; }
    const on = getMapLabelsEnabled();
    for (const layer of layers) {
        if (layer.id.startsWith('sx-')) continue;
        const visible = registry().isLayerVisible(layer, on);
        const want = visible ? 'visible' : 'none';
        if ((layer.layout?.visibility || 'visible') !== want) {
            try { map.setLayoutProperty(layer.id, 'visibility', want); } catch { /* layer gone mid-swap */ }
        }
    }
}

function applyStyle(map, entry, force) {
    const providerId = getEffectiveProviderId();
    const dark = isDark();
    if (!force && entry.providerId === providerId && entry.dark === dark) return;
    entry.providerId = providerId;
    entry.dark = dark;
    try {
        map.setStyle(registry().getStyle(providerId, { dark }), { diff: false });
    } catch (err) {
        console.warn('[MAP] Failed to set map style:', err);
    }
}

function watchMapForFailure(map) {
    map.on('style.load', () => applyLabels(map));
    map.on('sourcedata', e => {
        if (e.sourceId === registry().RASTER_SOURCE_ID && e.tile) googleTileLoaded = true;
    });
    map.on('error', e => {
        const fromGoogle = e?.sourceId === registry().RASTER_SOURCE_ID &&
            registry().isGoogleProvider(getEffectiveProviderId());
        if (!fromGoogle) {
            console.warn('[MAP]', e?.error?.message || e);
            return;
        }
        if (googleTileLoaded || sessionFallbackActive) return;
        googleTileErrors++;
        if (googleTileErrors >= 3) triggerFallback('repeated tile errors');
    });
}

// Probe one known tile via an <img> load so a blocked Google endpoint is
// detected even before the map requests visible tiles.
function probeGoogleReachable() {
    return new Promise(resolve => {
        const img = new Image();
        const timer = setTimeout(() => { img.src = ''; resolve(false); }, 5000);
        img.onload = () => { clearTimeout(timer); resolve(true); };
        img.onerror = () => { clearTimeout(timer); resolve(false); };
        img.src = registry().GOOGLE_PROBE_URL;
    });
}

function maybeStartProbe() {
    if (probeStarted || !registry().isGoogleProvider(getEffectiveProviderId())) return;
    probeStarted = true;
    probeGoogleReachable().then(ok => {
        // A loaded tile in the meantime also proves reachability: only fall
        // back when nothing from Google has loaded.
        if (!ok && !googleTileLoaded && !sessionFallbackActive) {
            triggerFallback('probe failed');
        }
    });
}

function triggerFallback(reason) {
    if (sessionFallbackActive) return;
    sessionFallbackActive = true;
    console.warn(`[MAP] Google tiles unavailable (${reason}), falling back to OpenFreeMap for this session`);
    applyEffectiveStyleToAllMaps();
    try {
        notify(t('ui.settings.mapProviderFallbackNotice'), { type: 'warn', timeoutMs: 6000 });
    } catch { /* toast is best-effort */ }
    window.electronAPI?.notifyMapProviderFallback?.();
}

function applyEffectiveStyleToAllMaps() {
    for (const [map, entry] of registeredMaps) applyStyle(map, entry, false);
}

/**
 * Apply the current provider and light/dark choice to every registered map
 * (e.g. after a dark-mode change). Exposed for script.js.
 */
export function refreshMapStyles() {
    applyEffectiveStyleToAllMaps();
}

/**
 * Give a MapLibre map the current provider's style and keep it registered
 * for live swaps (settings change, dark mode or fallback). The style is set
 * once the saved setting has loaded.
 * @param {maplibregl.Map} map
 */
export function attachMapStyle(map) {
    const entry = { providerId: null, dark: null };
    registeredMaps.set(map, entry);
    watchMapForFailure(map);
    loadSelectedProvider().then(() => {
        if (!registeredMaps.has(map)) return; // detached before setting loaded
        applyStyle(map, entry, true);
        maybeStartProbe();
    });
}

/** Unregister a map (call before map.remove()). */
export function detachMapStyle(map) {
    registeredMaps.delete(map);
}

/**
 * User picked a provider in Settings: persist it and swap all live maps.
 * An explicit choice also clears the session fallback so Google gets a
 * fresh chance (and a fresh probe) immediately.
 */
export async function setMapTileProvider(id) {
    selectedProviderId = registry().getProvider(id).id;
    sessionFallbackActive = false;
    googleTileErrors = 0;
    googleTileLoaded = false;
    probeStarted = false;
    settingLoadPromise = Promise.resolve(selectedProviderId);
    try {
        await window.electronAPI?.setSetting?.(SETTING_KEY, selectedProviderId);
    } catch (err) {
        console.warn('[MAP] Failed to persist map provider setting:', err);
    }
    applyEffectiveStyleToAllMaps();
    maybeStartProbe();
}
