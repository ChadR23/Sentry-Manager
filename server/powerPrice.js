'use strict';

// Electricity price for the cost shown next to energy: one price, or a
// time-of-use plan (peak / off-peak / weekend rates). Costs are summed at the
// price of each moment, so a conversion that runs through the night costs
// what it really cost.

const MAX_RATES = 12;
const TIME = /^([01]\d|2[0-3]):([0-5]\d)$/;

class PriceError extends Error {}

function money(value, what) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0 || n > 10) throw new PriceError(`${what}: enter a price per kWh between 0 and 10.`);
  return Math.round(n * 100000) / 100000;
}

const minutes = (hhmm) => {
  const m = TIME.exec(hhmm);
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
};

/** Checks and tidies what Settings sends; throws PriceError with a readable message. */
function parsePowerSettings(body = {}) {
  const currency = String(body.currency ?? '$').trim().slice(0, 3) || '$';
  if (/[<>&"'`\\]/.test(currency)) throw new PriceError('Use a currency symbol like $, €, £ or kr.');
  const mode = body.mode === 'tou' ? 'tou' : 'flat';
  const out = { currency, mode, pricePerKwh: money(body.pricePerKwh, 'Price'), defaultPrice: money(body.defaultPrice, 'Other hours'), rates: [] };
  const rates = Array.isArray(body.rates) ? body.rates : [];
  if (rates.length > MAX_RATES) throw new PriceError(`At most ${MAX_RATES} rates.`);
  for (const [i, r] of rates.entries()) {
    const label = String(r?.label ?? '').trim().slice(0, 24) || `Rate ${i + 1}`;
    if (/[<>&"'`\\]/.test(label)) throw new PriceError(`${label}: use plain words for the name.`);
    const price = money(r?.price, label);
    if (price === null) throw new PriceError(`${label}: enter its price per kWh.`);
    if (minutes(r?.from) === null || minutes(r?.to) === null) throw new PriceError(`${label}: times are HH:MM, like 07:00 and 21:30.`);
    if (r.from === r.to) throw new PriceError(`${label}: from and to are the same time.`);
    const days = [...new Set((Array.isArray(r?.days) ? r.days : []).map(Number).filter((d) => Number.isInteger(d) && d >= 0 && d <= 6))].sort();
    if (!days.length) throw new PriceError(`${label}: pick at least one day.`);
    out.rates.push({ label, price, days, from: r.from, to: r.to });
  }
  if (mode === 'tou' && !out.rates.length && out.defaultPrice === null) throw new PriceError('Add a rate or a price for the other hours.');
  return out;
}

/**
 * The time-of-use rate in force at `ms` (server time zone), or null. A rate
 * from 21:00 to 07:00 covers the night; it belongs to the day it starts.
 */
function rateAt(settings, ms) {
  if (settings?.mode !== 'tou') return null;
  const d = new Date(ms);
  const now = d.getHours() * 60 + d.getMinutes();
  const today = d.getDay();
  const yesterday = (today + 6) % 7;
  return (settings.rates || []).find((r) => {
    const from = minutes(r.from);
    const to = minutes(r.to);
    if (from === null || to === null) return false;
    return from < to ? r.days.includes(today) && now >= from && now < to
      : (r.days.includes(today) && now >= from) || (r.days.includes(yesterday) && now < to);
  }) || null;
}

/** The price per kWh at `ms`, or null when no price is set. */
function priceAt(settings, ms) {
  if (!settings) return null;
  if (settings.mode !== 'tou') return Number.isFinite(settings.pricePerKwh) ? settings.pricePerKwh : null;
  const rate = rateAt(settings, ms);
  if (rate) return rate.price;
  return Number.isFinite(settings.defaultPrice) ? settings.defaultPrice : null;
}

/** The rate's name at `ms`, for "now: Off-peak" in the UI. */
function rateNameAt(settings, ms) {
  if (settings?.mode !== 'tou') return null;
  return rateAt(settings, ms)?.label || (Number.isFinite(settings.defaultPrice) ? 'Other hours' : null);
}

/**
 * True while the cheapest price of a time-of-use plan is in force (for
 * automatic conversion "only at off-peak"); null without such a plan, so
 * the caller can treat it as "any time".
 */
function isCheapest(settings, ms) {
  if (settings?.mode !== 'tou') return null;
  const prices = (settings.rates || []).map((r) => r.price);
  if (Number.isFinite(settings.defaultPrice)) prices.push(settings.defaultPrice);
  if (!prices.length) return null;
  const now = priceAt(settings, ms);
  return now !== null && now <= Math.min(...prices) + 1e-9;
}

module.exports = { parsePowerSettings, priceAt, rateAt, rateNameAt, isCheapest, PriceError, MAX_RATES };
