'use strict';

// Electricity price: one price or a time-of-use plan; the price at a moment
// follows the plan, overnight rates included.

const test = require('node:test');
const assert = require('node:assert/strict');
const { parsePowerSettings, priceAt, rateNameAt, isCheapest, PriceError } = require('../server/powerPrice');

process.env.TZ = 'UTC';
const at = (iso) => Date.parse(`${iso}Z`);
const WEEKDAYS = [1, 2, 3, 4, 5];

const plan = parsePowerSettings({
  currency: '$', mode: 'tou', defaultPrice: 0.18,
  rates: [
    { label: 'Peak', price: 0.42, days: WEEKDAYS, from: '16:00', to: '21:00' },
    { label: 'Off-peak', price: 0.09, days: [0, 1, 2, 3, 4, 5, 6], from: '23:00', to: '07:00' }
  ]
});

test('a single price applies all the time', () => {
  const flat = parsePowerSettings({ pricePerKwh: '0.15', currency: '€' });
  assert.deepEqual(flat, { currency: '€', mode: 'flat', pricePerKwh: 0.15, defaultPrice: null, rates: [] });
  assert.equal(priceAt(flat, at('2026-10-23T03:00:00')), 0.15);
  assert.equal(priceAt(parsePowerSettings({}), at('2026-10-23T03:00:00')), null, 'no price, no cost');
});

test('time-of-use: peak on weekdays, overnight off-peak across midnight, other hours', () => {
  assert.equal(priceAt(plan, at('2026-10-23T17:30:00')), 0.42, 'Friday peak');
  assert.equal(priceAt(plan, at('2026-10-24T17:30:00')), 0.18, 'Saturday: no peak');
  assert.equal(priceAt(plan, at('2026-10-23T23:30:00')), 0.09, 'night, before midnight');
  assert.equal(priceAt(plan, at('2026-10-24T06:59:00')), 0.09, 'night, after midnight');
  assert.equal(priceAt(plan, at('2026-10-24T07:00:00')), 0.18, 'the end time is not included');
  assert.equal(priceAt(plan, at('2026-10-23T12:00:00')), 0.18);
  assert.equal(rateNameAt(plan, at('2026-10-23T17:30:00')), 'Peak');
  assert.equal(rateNameAt(plan, at('2026-10-23T12:00:00')), 'Other hours');
});

test('an overnight rate belongs to the day it starts', () => {
  const fridayNight = parsePowerSettings({ mode: 'tou', rates: [{ label: 'Weekend night', price: 0.05, days: [5], from: '22:00', to: '06:00' }] });
  assert.equal(priceAt(fridayNight, at('2026-10-24T05:00:00')), 0.05, 'Saturday 05:00 is Friday night');
  assert.equal(priceAt(fridayNight, at('2026-10-23T05:00:00')), null, 'Friday 05:00 is Thursday night');
});

test('bad input is refused with a readable reason', () => {
  const bad = (body, re) => assert.throws(() => parsePowerSettings(body), (e) => e instanceof PriceError && re.test(e.message));
  bad({ pricePerKwh: -1 }, /between 0 and 10/);
  bad({ pricePerKwh: 'abc' }, /between 0 and 10/);
  bad({ currency: '<b>' }, /currency symbol/);
  bad({ mode: 'tou', rates: [{ label: 'Peak', price: 0.4, days: [1], from: '7:00', to: '21:00' }] }, /HH:MM/);
  bad({ mode: 'tou', rates: [{ label: 'Peak', price: 0.4, days: [], from: '07:00', to: '21:00' }] }, /at least one day/);
  bad({ mode: 'tou', rates: [{ label: 'Peak', price: 0.4, days: [1], from: '07:00', to: '07:00' }] }, /same time/);
  bad({ mode: 'tou', rates: [] }, /Add a rate/);
  bad({ mode: 'tou', rates: Array.from({ length: 13 }, () => ({ price: 1, days: [1], from: '01:00', to: '02:00' })) }, /At most 12/);
});

test('off-peak only: true while the cheapest rate is in force, null without a plan', () => {
  assert.equal(isCheapest(plan, at('2026-10-24T02:00:00')), true, 'overnight off-peak');
  assert.equal(isCheapest(plan, at('2026-10-23T12:00:00')), false, 'other hours cost more');
  assert.equal(isCheapest(plan, at('2026-10-23T17:00:00')), false, 'peak');
  assert.equal(isCheapest(parsePowerSettings({ pricePerKwh: 0.2 }), at('2026-10-23T17:00:00')), null);
});
