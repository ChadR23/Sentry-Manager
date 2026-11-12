// The one unit choice for every interface: miles or kilometres. Speed,
// distance, temperature and tire pressure all follow it, so a page never shows
// mph next to °C: miles means mph, °F and psi; kilometres means km/h, °C and
// bar. It is chosen with any speed or distance button (the Viewer's mph/km/h,
// the Driving page's Miles/Kilometres, a pack's own) and kept in this browser
// (localStorage 'sentry-driving-units': 'mi' or 'km', the Driving page's key).
// Not chosen yet: miles where the language is US, UK, Liberian or Burmese
// English (or English with no country), else kilometres.
//
// A classic script, as web/carCalc.js: import '/web/units.js' from a module (it
// sets globalThis.SentryUnits), load it with <script>, or require() it.
(function (root) {
  'use strict';
  if (root.SentryUnits && root.SentryUnits.version === 1) {
    if (typeof module === 'object' && module && module.exports) module.exports = root.SentryUnits;
    return;
  }
  const KEY = 'sentry-driving-units';
  const EVENT = 'sentry-units';
  const MILES_LANG = /^en(-(US|GB|LR|MM))?$/i;

  const stored = () => {
    try {
      const v = root.localStorage && root.localStorage.getItem(KEY);
      return v === 'km' || v === 'mi' ? v : null;
    } catch {
      return null;
    }
  };
  /** Kilometres when the language is not one of the miles ones. */
  const localeMetric = (lang) => !MILES_LANG.test(String(lang || (root.navigator && root.navigator.language) || 'en-US'));
  /** true: kilometres (km/h, °C, bar); false: miles (mph, °F, psi). */
  const metric = () => {
    const s = stored();
    return s ? s === 'km' : localeMetric();
  };
  /** Whether someone has chosen yet (else it is the language's). */
  const chosen = () => stored() !== null;

  const listeners = new Set();
  const tell = () => {
    const m = metric();
    for (const fn of [...listeners]) { try { fn(m); } catch { /* the others still */ } }
  };
  /** Choose: true for kilometres, false for miles. Every page listening redraws. */
  function set(isMetric) {
    const v = isMetric ? 'km' : 'mi';
    try { root.localStorage && root.localStorage.setItem(KEY, v); } catch { /* for this visit then */ }
    memo = v;
    tell();
    try { if (typeof root.dispatchEvent === 'function' && typeof root.CustomEvent === 'function') root.dispatchEvent(new root.CustomEvent(EVENT, { detail: { metric: Boolean(isMetric) } })); } catch { /* no events here */ }
  }
  let memo = null;
  /** An older choice of a page's own (its saved mph/km/h): taken only when none has been made here yet. */
  function adopt(isMetric) {
    if (typeof isMetric !== 'boolean' || chosen()) return metric();
    set(isMetric);
    return metric();
  }
  /** fn(metric) after each change, here or in another tab or frame of this site. Returns the off switch. */
  function onChange(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
  }
  // another tab or frame (the Viewer is a frame in the page) changed it
  try {
    if (typeof root.addEventListener === 'function') {
      root.addEventListener('storage', (e) => { if (!e || e.key === KEY || e.key === null) { if (stored() !== memo) { memo = stored(); tell(); } } });
    }
  } catch { /* none */ }
  memo = stored();

  // ---- unit spellings: a DBC writes °C as "C", "degC", "deg C", "DegC", "°C", "Celsius" ----
  const SPELLING = {
    c: 'C', degc: 'C', degreec: 'C', degreesc: 'C', celsius: 'C', degcelsius: 'C', degreescelsius: 'C', centigrade: 'C',
    f: 'F', degf: 'F', degreef: 'F', degreesf: 'F', fahrenheit: 'F', degfahrenheit: 'F', degreesfahrenheit: 'F',
    k: 'K', kelvin: 'K',
    kph: 'km/h', 'km/h': 'km/h', kmh: 'km/h', 'km/hr': 'km/h', kmph: 'km/h', 'kmperh': 'km/h', 'kilometersperhour': 'km/h', 'kilometresperhour': 'km/h',
    mph: 'mph', 'mi/h': 'mph', 'mi/hr': 'mph', 'milesperhour': 'mph',
    'm/s': 'm/s', mps: 'm/s', 'm/sec': 'm/s',
    km: 'km', kilometer: 'km', kilometers: 'km', kilometre: 'km', kilometres: 'km',
    mi: 'mi', mile: 'mi', miles: 'mi',
    m: 'm', meter: 'm', meters: 'm', metre: 'm', metres: 'm',
    deg: 'deg', degree: 'deg', degrees: 'deg',
    kwh: 'kWh', wh: 'Wh', kw: 'kW', w: 'W',
    nm: 'Nm', 'n*m': 'Nm', 'n.m': 'Nm', newtonmeter: 'Nm', newtonmetre: 'Nm',
    kpa: 'kPa', bar: 'bar', psi: 'psi', mbar: 'mbar', hpa: 'hPa', pa: 'Pa'
  };
  /**
   * A unit as one spelling (above), or null when it is not one this knows. Case,
   * spaces, underscores and the degree sign (°, º) do not matter: "deg C" is "C".
   */
  function canonUnit(u) {
    if (typeof u !== 'string') return null;
    const k = u.replace(/\u2103/g, 'C').replace(/\u2109/g, 'F').replace(/[\s_°º˚]+/g, '').replace(/^degrees?(?=[cf]$)/i, 'deg').toLowerCase();
    if (!k) return null;
    return Object.prototype.hasOwnProperty.call(SPELLING, k) ? SPELLING[k] : null;
  }

  // ---- temperatures (°C in, the choice's unit out) ----
  const toF = (c) => c * 1.8 + 32;
  /** '°C' or '°F' for the choice (or `m`). */
  const tempUnit = (m = metric()) => (m ? '°C' : '°F');
  /** A temperature in °C as a number in the chosen unit. */
  const temp = (c, m = metric()) => (Number.isFinite(c) ? (m ? c : toF(c)) : null);
  /** A difference of temperatures (a spread) in °C, in the chosen unit. */
  const tempDelta = (c, m = metric()) => (Number.isFinite(c) ? (m ? c : c * 1.8) : null);
  /** "21 °C" / "70 °F" ({ digits, space: false for "21°C", m }); '—' with no value. */
  function tempText(c, { digits = 0, space = true, m = metric() } = {}) {
    const v = temp(Number(c), m);
    if (v === null || c === null || c === undefined || c === '') return '—';
    return `${digits ? v.toFixed(digits) : Math.round(v)}${space ? ' ' : ''}${tempUnit(m)}`;
  }
  /** Text with "92 °C" in it (a server's notification) in the chosen unit: "198 °F". */
  function inText(s, m = metric()) {
    if (typeof s !== 'string' || m) return s;
    return s.replace(/(-?\d+(?:[.,]\d+)?)(\s?)°\s?C\b/g, (all, n, sp) => {
      const c = Number(n.replace(',', '.'));
      if (!Number.isFinite(c)) return all;
      const dp = (n.split(/[.,]/)[1] || '').length;
      return `${toF(c).toFixed(dp)}${sp}°F`;
    });
  }
  // ---- tire pressures (kPa in): psi with miles, bar with kilometres ----
  const pressureUnit = (m = metric()) => (m ? 'bar' : 'psi');
  const pressure = (kpa, m = metric()) => (Number.isFinite(kpa) ? (m ? kpa / 100 : kpa * 0.1450377) : null);
  // ---- speed and distance names, for pages that keep their own words ----
  const speedUnit = (m = metric()) => (m ? 'km/h' : 'mph');
  const distanceUnit = (m = metric()) => (m ? 'km' : 'mi');

  const api = {
    version: 1, KEY, EVENT, metric, chosen, set, adopt, onChange, localeMetric,
    canonUnit, tempUnit, temp, tempDelta, tempText, inText, pressureUnit, pressure, speedUnit, distanceUnit
  };
  root.SentryUnits = api;
  if (typeof module === 'object' && module && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
