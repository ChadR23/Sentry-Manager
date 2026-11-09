// Stats worked out from the car's own signals (no one CAN signal gives them):
// battery power from the pack's volts and amps, charging power, the 12 V
// battery's power, efficiency and so on. One table for the Viewer
// (web/statDash.js: computed stats next to the CAN ones) and the decoded CSV
// export (server/canCalc.js: the same stats as extra signals), so both give the
// same numbers. A classic script: import '/web/carCalc.js' from a module (it
// sets globalThis.SentryCarCalc), or require() it on the server.
//
// Signs, checked against a 2026 Model Y's logs (parked, cabin kept warm at
// 2 C outside): SmoothBattCurrent132 is positive while the pack gives power.
// Over 20 minutes the integral of BattVoltage132 x SmoothBattCurrent132 was
// 0.286 kWh and TotalDischargeKWh3D2 went up by 0.286 kWh (TotalCharge stayed);
// when the motors heated the pack (RearPower266 + FrontPower2E5 = 5 kW) the
// battery power rose from 0.9 to 6.8 kW. So battery power = V x I / 1000,
// positive = out of the pack (driving, heating), negative = into it
// (regenerating, charging), as Scan My Tesla shows it. v12vBattCurrent261 is
// positive while the 12 V battery is charged (its voltage is higher then, and
// it went negative when a big load dipped the bus): the 12 V battery's power is
// shown the same way as the pack's, positive = the battery gives power.
//
// Each stat: { id, label, unit (a key the Viewer converts: kW, W, C, Cdelta,
// Wh/mi, mi, kWh, or '' for a word), digits, uses: [[a name, or the names that
// can stand for it, best first], ...] (all needed), also: [names read when
// there] , value(get, hist) }. get(name) is a signal's latest value (null: none
// yet). A stat with `window` needs the moments before too: hist.at(name, dtMs)
// is the value dtMs from now (dtMs <= 0), hist.since the ms from the clip's
// start to now; those are worked out in the Viewer only.
(function (root) {
  'use strict';

  const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  /** The first of the names with a value. */
  function first(get, names) {
    for (const n of names) {
      const v = num(get(n));
      if (v !== null) return v;
    }
    return null;
  }
  const VOLTS = ['BattVoltage132'];
  const AMPS = ['SmoothBattCurrent132', 'RawBattCurrent132'];
  // what says "charging now", best first, with the raw value that means it
  // (BMS_CHARGING, CP_CHARGE_ENABLED, PCS_CHARGE_ENABLED); the first one there decides
  const CHARGE = [['BMS_uiChargeStatus', 3], ['CP_hvChargeStatus_13D', 5], ['CP_hvChargeStatus_23D', 5], ['PCS_hvChargeStatus', 2]];
  const CHARGE_NAMES = CHARGE.map(([n]) => n);
  const LV_VOLTS = ['v12vBattVoltage261'];
  const LV_AMPS = ['v12vBattCurrent261'];
  // (a legacy Model S/X's after the Model 3/Y one: server/dbc/sx-legacy.dbc, in km/h too)
  const SPEED = ['DI_vehicleSpeed', 'DI_vehicleSpeed_116', 'DI_vehicleSpeed_118']; // km/h
  const KMH_PER_MPH = 1.609344;

  /** Battery power, kW: positive out of the pack, negative into it. */
  function batteryKw(get) {
    const v = first(get, VOLTS);
    const i = first(get, AMPS);
    return v === null || i === null ? null : (v * i) / 1000;
  }
  /** Charging now: true, false, or null (nothing says). */
  function charging(get) {
    for (const [n, on] of CHARGE) {
      const v = num(get(n));
      if (v !== null) return Math.round(v) === on;
    }
    return null;
  }
  /** The 12 V battery's current, A (positive: being charged). */
  const lvAmps = (get) => first(get, LV_AMPS);

  // ---- over a window (the Viewer): sampled every STEP ms
  const STEP = 250;
  const EFF_WINDOW = 10_000;
  const MIN_KMH = 5 * KMH_PER_MPH; // moving: above 5 mph on average
  /** Wh per mile over the last 10 s, while moving; null when parked or slow. */
  function efficiency(get, hist) {
    if (!hist) return null;
    let wh = 0;
    let km = 0;
    let n = 0;
    for (let dt = -EFF_WINDOW; dt <= 0; dt += STEP) {
      const at = (name) => hist.at(name, dt);
      const p = batteryKw(at);
      const s = first(at, SPEED);
      if (p === null || s === null) continue;
      wh += (p * 1000 * STEP) / 3_600_000;
      km += (s * STEP) / 3_600_000;
      n++;
    }
    if (n < 8) return null; // (two seconds of data at least)
    const kmhAvg = km / ((n * STEP) / 3_600_000);
    if (kmhAvg < MIN_KMH) return null;
    return wh / (km / KMH_PER_MPH);
  }
  /** kWh into (negative) or out of the pack from the clip's start to now (sampled every half second). */
  function energyClip(get, hist) {
    if (!hist || !Number.isFinite(hist.since) || hist.since < 0) return null;
    const step = 500;
    let kwh = 0;
    let any = false;
    for (let dt = -Math.floor(hist.since / step) * step; dt < 0; dt += step) {
      const p = batteryKw((name) => hist.at(name, dt));
      if (p === null) continue;
      kwh += (p * step) / 3_600_000;
      any = true;
    }
    return any ? kwh : null;
  }

  const CALCS = [
    { id: 'calc.batteryPower', label: 'Battery power', unit: 'kW', digits: 1, uses: [VOLTS, AMPS], value: batteryKw,
      about: 'Pack volts x amps: positive while the pack gives power (driving, heating), negative while it takes it (regenerating, charging)' },
    { id: 'calc.drivePower', label: 'Drive power', unit: 'kW', digits: 1, uses: [VOLTS, AMPS], value: (get) => { const p = batteryKw(get); return p === null ? null : Math.max(0, p); },
      about: 'The power the pack gives (driving, heating, everything on); 0 while it takes power' },
    { id: 'calc.regenPower', label: 'Regen power', unit: 'kW', digits: 1, uses: [VOLTS, AMPS], also: CHARGE_NAMES,
      value: (get) => { const p = batteryKw(get); if (p === null) return null; return p < 0 && charging(get) !== true ? -p : 0; },
      about: 'The power going back into the pack while not charging (regenerating); 0 otherwise' },
    { id: 'calc.chargingPower', label: 'Charging power', unit: 'kW', digits: 1, uses: [VOLTS, AMPS, CHARGE_NAMES],
      value: (get) => { if (charging(get) !== true) return null; const p = batteryKw(get); return p === null ? null : -p; },
      about: 'The power into the pack while the car says it is charging (AC or DC); no value when not charging' },
    { id: 'calc.dcChargerPower', label: 'DC charger power', unit: 'kW', digits: 1, uses: [['CP_evseOutputDcVoltage'], ['CP_evseOutputDcCurrent']], also: ['CP_evseOutputDcCurrentStale'],
      value: (get) => {
        const v = num(get('CP_evseOutputDcVoltage'));
        const i = num(get('CP_evseOutputDcCurrent'));
        if (v === null || i === null || num(get('CP_evseOutputDcCurrentStale')) === 1 || !(v > 0 && i > 0)) return null;
        return (v * i) / 1000;
      },
      about: 'What a DC fast charger says it gives (its volts x amps); no value otherwise' },
    { id: 'calc.lv12Power', label: '12V battery power', unit: 'W', digits: 0, uses: [LV_VOLTS, LV_AMPS],
      value: (get) => { const v = first(get, LV_VOLTS); const i = lvAmps(get); return v === null || i === null ? null : -(v * i); },
      about: "The 12 V battery's own power (its volts x amps): positive while it gives power, negative while it is charged. The DC-DC converter's output is not readable on newer firmware" },
    { id: 'calc.lv12State', label: '12V battery state', unit: '', uses: [LV_AMPS],
      value: (get) => { const i = lvAmps(get); if (i === null) return null; return Math.abs(i) < 0.2 ? 'Resting' : i > 0 ? 'Charging' : 'Discharging'; },
      about: 'From the 12 V battery current: charging, discharging, or resting (under 0.2 A)' },
    { id: 'calc.battTemp', label: 'Battery temp', unit: 'C', digits: 1, uses: [['BattBrickTempMax332'], ['BattBrickTempMin332']],
      value: (get) => { const a = num(get('BattBrickTempMax332')); const b = num(get('BattBrickTempMin332')); return a === null || b === null ? null : (a + b) / 2; },
      about: 'The middle of the warmest and coolest brick' },
    { id: 'calc.battTempSpread', label: 'Battery temp spread', unit: 'Cdelta', digits: 1, uses: [['BattBrickTempMax332'], ['BattBrickTempMin332']],
      value: (get) => { const a = num(get('BattBrickTempMax332')); const b = num(get('BattBrickTempMin332')); return a === null || b === null ? null : a - b; },
      about: 'The warmest brick less the coolest' },
    { id: 'calc.efficiency', label: 'Efficiency now', unit: 'Wh/mi', digits: 0, window: true, uses: [VOLTS, AMPS, SPEED], value: efficiency,
      about: 'Battery power / speed over the last 10 seconds, while moving above 5 mph; no value when parked' },
    { id: 'calc.rangeNow', label: 'Range at this efficiency', unit: 'mi', digits: 0, window: true, uses: [VOLTS, AMPS, SPEED, ['BMS_nominalEnergyRemaining']], also: ['BMS_energyBuffer'],
      value: (get, hist) => {
        const e = efficiency(get, hist);
        const left = num(get('BMS_nominalEnergyRemaining'));
        if (e === null || !(e > 0) || left === null) return null;
        const usable = left - (num(get('BMS_energyBuffer')) || 0);
        return usable > 0 ? (usable * 1000) / e : null;
      },
      about: 'The energy left (less the buffer) at the efficiency of the last 10 seconds; only while driving' },
    { id: 'calc.energyClip', label: 'Energy used (this clip)', unit: 'kWh', digits: 2, window: true, uses: [VOLTS, AMPS], value: energyClip,
      about: 'Battery power added up from the start of this clip to now: negative when more went in (regenerating, charging)' }
  ];

  const api = { CALCS, batteryKw, charging, first, KMH_PER_MPH };
  root.SentryCarCalc = api;
  if (typeof module === 'object' && module && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
