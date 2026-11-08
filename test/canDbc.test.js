'use strict';

// Decoding CAN frames with a DBC: byte order, sign, scale, multiplexed
// signals and value names; and the bundled Model 3/Y DBC reads whole.

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseDbc, decodeFrame, bundledDbc } = require('../server/canDbc');

const DBC = `
BO_ 306 HVBatt: 8 VehicleBus
 SG_ BattVoltage : 0|16@1+ (0.01,0) [0|655.35] "V" Receiver
 SG_ BattCurrent : 16|16@1- (0.1,0) [-3276.8|3276.7] "A" Receiver

BO_ 2147484418 ExtendedThing: 8 ChassisBus
 SG_ Motorola12 : 7|12@0+ (1,0) [0|4095] "" Receiver

BO_ 818 BattTemps: 8 VehicleBus
 SG_ TempMux M : 0|2@1+ (1,0) [0|3] "" Receiver
 SG_ TempMax m0 : 16|8@1+ (0.5,-40) [0|0] "C" Receiver
 SG_ CellMax m1 : 16|12@1+ (0.002,0) [0|0] "V" Receiver

VAL_ 306 BattCurrent 0 "ZERO" ;
CM_ SG_ 818 TempMax "Max Batt Brick
 Temp";
`;

test('little and big endian, signed, scaled; extended ids; comments over two lines', () => {
  const { messages } = parseDbc(DBC);
  const batt = messages.get(306);
  const b = Buffer.alloc(8);
  b.writeUInt16LE(39904, 0); // 399.04 V
  b.writeInt16LE(-125, 2); // -12.5 A
  const v = Object.fromEntries(decodeFrame(batt, b).map(([s, x]) => [s.name, Math.round(x * 100) / 100]));
  assert.deepEqual(v, { BattVoltage: 399.04, BattCurrent: -12.5 });
  assert.deepEqual(batt.signals[1].values, { 0: 'ZERO' });

  const ext = messages.get(770); // 2147484418 - 2^31
  assert.equal(ext.name, 'ExtendedThing');
  // Motorola: 12 bits from bit 7 (the top of byte 0) down into byte 1: 0xAB, 0xC0 -> 0xABC
  assert.equal(decodeFrame(ext, Buffer.from([0xab, 0xc0, 0, 0, 0, 0, 0, 0]))[0][1], 0xabc);

  assert.equal(messages.get(818).signals[1].comment, 'Max Batt Brick Temp');
});

test('multiplexed: only the signals of the frame\'s mux value', () => {
  const { messages } = parseDbc(DBC);
  const m = messages.get(818);
  const temps = decodeFrame(m, Buffer.from([0, 0, 130, 0, 0, 0, 0, 0])).map(([s, v]) => [s.name, v]);
  assert.deepEqual(temps, [['TempMux', 0], ['TempMax', 25]]);
  const cells = decodeFrame(m, Buffer.from([1, 0, 0x14, 0x07, 0, 0, 0, 0])).map(([s, v]) => [s.name, Math.round(v * 1000) / 1000]);
  assert.deepEqual(cells, [['TempMux', 1], ['CellMax', 3.624]]);
});

test('the bundled Model 3/Y DBC: every message and signal, the CAN Bridge presets among them', () => {
  const { messages } = bundledDbc();
  assert.ok(messages.size >= 150);
  const names = new Set([...messages.values()].flatMap((m) => m.signals.map((s) => s.name)));
  for (const n of ['DI_vehicleSpeed', 'DI_gear', 'BattVoltage132', 'BattBrickTempMax332', 'SOCUI292', 'IBST_driverBrakeApply']) assert.ok(names.has(n), n);
});
