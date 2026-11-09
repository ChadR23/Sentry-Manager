
// Which car a vehicle is (Model 3, Y, S or X, and its year or generation), and
// so which DBC set (server/canDbc.js PROFILES) decodes its CAN data. A classic
// script, as web/carCalc.js: the server require()s it (server/carModels.js), the
// vehicle settings import '/web/carModels.js' (it sets globalThis.SentryCarModels).
//
// The car tells it itself: its VIN is on the CAN bus. A Model 3 or Y (and a 2021+
// Model S or X) sends it in 0x405 (first byte 0x10, 0x11, 0x12: three, seven and
// seven characters in bytes 5-7, 1-7, 1-7); a Model S or X from before the 2021
// refresh in 0x508 (first byte 0, 1, 2: seven, seven and three characters from
// byte 1, as Open Vehicle Monitoring System reads it). The VIN's 4th character
// is the model (S, X, 3, Y), the 10th the model year (L 2020, M 2021, N 2022, P
// 2023, R 2024, S 2025, T 2026, ...), the first three the maker and plant (5YJ
// Fremont, 7SA Tesla US, LRW Shanghai, XP7 Berlin). Which message carried it
// says the architecture too: a Model S or X that sends 0x508 is a legacy car
// whatever its year (a 2021 model year can be either).
//
// Each vehicle has a setting (Settings > the vehicle: "Car model" and "Year"),
// Automatic by default: what the car says, else the Model 3/Y set (the only one
// checked on a real car: the owner's Model Y). A setting overrides the VIN.

(function (root) {
  'use strict';

  const MODELS = { 3: 'Model 3', Y: 'Model Y', S: 'Model S', X: 'Model X' };
  // the generations people tell apart, by model year (the VIN's), each with its DBC set. The
  // Model 3/Y set is the same for every 3/Y generation: no public source has a layout that
  // differs by generation, and the firmware overrides (server/dbc/override.dbc) follow the
  // software, not the year. A set of its own for a generation is a new PROFILES entry there.
  const GENERATIONS = {
    3: [
      { id: '3-2017', label: '2017-2023', from: 2017, to: 2023, profile: 'tesla-3y' },
      { id: '3-2024', label: '2024 and later (Highland)', from: 2024, to: 9999, profile: 'tesla-3y' }
    ],
    Y: [
      { id: 'Y-2020', label: '2020-2024', from: 2020, to: 2024, profile: 'tesla-3y' },
      { id: 'Y-2025', label: '2025 and later (Juniper)', from: 2025, to: 9999, profile: 'tesla-3y' }
    ],
    S: [
      { id: 'S-2012', label: '2012-2014 (before Autopilot hardware)', from: 2012, to: 2014, profile: 'tesla-sx-legacy', legacy: true },
      { id: 'S-2015', label: '2015-2020', from: 2015, to: 2020, profile: 'tesla-sx-legacy', legacy: true },
      { id: 'S-2021', label: '2021 and later (refresh)', from: 2021, to: 9999, profile: 'tesla-3y' }
    ],
    X: [
      { id: 'X-2016', label: '2016-2020', from: 2015, to: 2020, profile: 'tesla-sx-legacy', legacy: true },
      { id: 'X-2021', label: '2021 and later (refresh)', from: 2021, to: 9999, profile: 'tesla-3y' }
    ]
  };
  const DEFAULT_PROFILE = 'tesla-3y';
  // the VIN's 10th character: the model year (letters I, O, Q, U, Z and the digit 0 are not used)
  const YEAR_CODES = 'ABCDEFGHJKLMNPRSTVWXY123456789';
  const VIN_RE = /^[A-HJ-NPR-Z0-9]{17}$/;
  const PLANTS = { '5YJ': 'Fremont', '7SA': 'Tesla US', LRW: 'Shanghai', XP7: 'Berlin', '7G2': 'Tesla US', SFZ: 'Hethel' };

  /** A model year from the VIN's 10th character (2010 to 2039), or null. */
  function yearOf(code) {
    const i = YEAR_CODES.indexOf(String(code || '').toUpperCase());
    return i < 0 ? null : 2010 + i;
  }

  /** What a VIN says: { vin, model ('3', 'Y', 'S', 'X' or null), year, plant }, or null when it is no VIN. */
  function decodeVin(vin) {
    const v = String(vin || '').trim().toUpperCase();
    if (!VIN_RE.test(v)) return null;
    const model = Object.hasOwn(MODELS, v[3]) ? v[3] : null;
    return { vin: v, model, year: yearOf(v[9]), plant: PLANTS[v.slice(0, 3)] || null };
  }

  /** The generation of a model for a model year (and, for S/X, whether the car is a legacy one), or null. */
  function generationFor(model, year, legacy = null) {
    const list = GENERATIONS[model];
    if (!list) return null;
    if (legacy !== null) {
      const kind = list.filter((g) => Boolean(g.legacy) === legacy);
      if (!kind.length) return null;
      if (!year) return legacy ? kind[kind.length - 1] : kind[0];
      return kind.find((g) => year >= g.from && year <= g.to) || (year < kind[0].from ? kind[0] : kind[kind.length - 1]);
    }
    if (!year) return null;
    return list.find((g) => year >= g.from && year <= g.to) || (year < list[0].from ? list[0] : list[list.length - 1]);
  }
  const generationById = (id) => Object.values(GENERATIONS).flat().find((g) => g.id === id) || null;

  /**
   * The VIN from a log's frames, collected one at a time: add(id, payload bytes) returns the
   * decoded VIN (with `via`: '0x405' or '0x508') once all three parts of one message came.
   */
  function vinCollector() {
    const parts = { 0x405: [], 0x508: [] };
    let found = null;
    const chars = (b, from, to) => {
      let s = '';
      for (let i = from; i <= to && i < b.length; i++) s += String.fromCharCode(b[i]);
      return s;
    };
    return {
      add(id, b) {
        if (found || !b || b.length < 8) return found;
        const p = parts[id];
        if (!p) return null;
        if (id === 0x405) {
          if ((b[0] & 0xF0) !== 0x10 || (b[0] & 0x0F) > 2) return null;
          const i = b[0] & 0x0F;
          p[i] = i === 0 ? chars(b, 5, 7) : chars(b, 1, 7);
        } else {
          if (b[0] > 2) return null;
          p[b[0]] = b[0] === 2 ? chars(b, 1, 3) : chars(b, 1, 7);
        }
        if (p[0] && p[1] && p[2]) {
          const d = decodeVin(p.join(''));
          if (d) found = { ...d, via: id === 0x405 ? '0x405' : '0x508' };
          else p.length = 0; // (parts of two different frames' worth: start again)
        }
        return found;
      },
      get vin() { return found; }
    };
  }

  /** A vehicle's setting, cleaned: { model: 'auto' | '3' | 'Y' | 'S' | 'X', generation: 'auto' | a generation id of that model }. */
  function normalizeCar(input) {
    const model = Object.hasOwn(MODELS, String(input?.model)) ? String(input.model) : 'auto';
    const gen = String(input?.generation || 'auto');
    const generation = model !== 'auto' && GENERATIONS[model].some((g) => g.id === gen) ? gen : 'auto';
    return { model, generation };
  }

  /**
   * The car a vehicle is, from its setting and what its CAN data said (detected: decodeVin's
   * answer with `via`, or null): { model, modelLabel, year, generation, generationLabel, profile,
   * source: 'setting' | 'vin' | 'default', legacy }.
   */
  function resolveCar(setting, detected) {
    const s = normalizeCar(setting);
    const det = detected && Object.hasOwn(MODELS, String(detected.model)) ? detected : null;
    const model = s.model !== 'auto' ? s.model : det?.model || null;
    const sameCar = det && det.model === model;
    let gen = null;
    let source = 'default';
    if (model && s.generation !== 'auto') { gen = generationById(s.generation); source = 'setting'; }
    else if (model && sameCar) {
      // (a Model S or X that sends 0x508 is a legacy car, one that sends 0x405 a refreshed one)
      const legacy = model === 'S' || model === 'X' ? det.via === '0x508' ? true : det.via === '0x405' ? false : null : null;
      gen = generationFor(model, det.year, legacy);
      source = s.model !== 'auto' ? 'setting' : 'vin';
    } else if (model) source = 'setting';
    return {
      model,
      modelLabel: model ? MODELS[model] : null,
      year: sameCar ? det.year : null,
      generation: gen?.id || null,
      generationLabel: gen?.label || null,
      profile: gen?.profile || DEFAULT_PROFILE,
      legacy: Boolean(gen?.legacy),
      source
    };
  }

  /** The choices for the vehicle settings: [{ id, label, generations: [{ id, label }] }]. */
  const choices = () => Object.entries(MODELS).map(([id, label]) => ({ id, label, generations: GENERATIONS[id].map((g) => ({ id: g.id, label: g.label })) }));

  /** A VIN as the API shows it: maker, model and year characters, not the serial number. */
  const maskVin = (vin) => (VIN_RE.test(String(vin || '')) ? `${vin.slice(0, 11)}******` : null);

  const api = { MODELS, GENERATIONS, DEFAULT_PROFILE, decodeVin, yearOf, generationFor, generationById, vinCollector, normalizeCar, resolveCar, choices, maskVin };
  root.SentryCarModels = api;
  if (typeof module === 'object' && module && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
