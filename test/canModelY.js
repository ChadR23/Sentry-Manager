'use strict';

// Frames from a 2026 Model Y's own CAN Bridge logs (2026-11-08, parked at
// home at night, charge complete, about 2 C outside), byte for byte: each id
// with the pages it sends in turn, and on which bus. The tests build candump
// logs from them, so the decoding is checked against what the car really sends.
//
//   frames(i, pages) -> [[bus, id, payload], ...]   the frames of the i-th tenth of a second
//   gps04F(lat, lon, acc) -> 0x04F's payload with that position (the rest of the can3 frame's bits)

const PAGES = {
  // cabin: 3-bit page index (page 4 read as page 0 gave 132 C)
  'can0:243': ['00FCCF4C9C360A29', '01987F418000A1A1', '02F8291104000000', 'C3200000E4458100', '04F0B106AE81817B'],
  // 12 V battery: 3-bit page index (page 5 read as page 1 gave 3.6 V)
  'can0:261': ['0010EBFFFF4F40AD', '31186300514BFA67', '6231FF07A05903BA', '735A16000040145C', 'EC16B8590240249E', '452360CA9A4230C3'],
  // energy: paged now (the flat layout gave 158 kWh remaining, 0 kWh full)
  'can0:352': ['0080310DB40BA90B', '01003001A90B3B00', '2201930B090860DB', '03A30B930B000000'],
  // BMS thermal: two kinds of frame (read flat: pack max 15 C / -25 C, min above max)
  'can0:312': ['00E566441489131D', 'C9214817408D0400'],
  // brick temperatures and voltages (the base layout is right)
  'can0:332': ['04007B7A7A000000', '1120020823150000'],
  // the tires, on the vehicle bus now: pages 0-5
  'can0:219': ['0080473088600400', '0100472F8E610400', '0200462F8B530400', '0300463089520400', '0474740000000000', '0500676664640000'],
  // 0x219 on the chassis bus is a counter now (read as tires: all four 3.2 bar)
  'can1:219': ['9081340000000000', '9181350000000000', '9281360000000000', '9381370000000000'],
  // GPS speed and heading: the chassis bus's, and the Screenmate's own can3 (different data)
  'can1:3D9': ['0000001000000000'],
  'can3:3D9': ['3F01000000000000'],
  // the car's GPS position, only on can3 (the Screenmate's own bus): 40.199897, -107.523232, 25 m
  // (parked in the garage: a poor fix)
  'can3:04F': ['D9666502367599FA'],
  // 0x3FE on can0: counters, not brake temperatures
  'can0:3FE': ['D9C0020B2CB0002F', 'DAC1020B2CB0002F', 'DBC2020B2CB0002F'],
  // SOC and odometer: one layout, steady
  'can0:292': ['78DF4DF8DF010000'],
  // UI_cpuTemperature is in 0x353 (30 C here) and in 0x00C (a frame made for the test: 50 C)
  'can0:353': ['FB0F39800808F8F6'],
  'can0:00C': ['000000000000000A']
};

/** The frames of the i-th tenth of a second: every id once, its pages in turn. */
function frames(i, all = PAGES) {
  return Object.entries(all).map(([key, pages]) => {
    const [bus, id] = key.split(':');
    return [bus, id, pages[i % pages.length]];
  });
}

/** A candump -L log from `fromMs` for `tenths` tenths of a second. */
function candump(fromMs, tenths, pages = PAGES) {
  const lines = ['# canbridge v1 app=0.2.120 build=120 device=Screenmate_Screenmate_One ts_source=helper-receive jitter=unmeasured'];
  for (let i = 0; i < tenths; i++) {
    const t = fromMs + i * 100;
    const stamp = `${Math.floor(t / 1000)}.${String(Math.round((t % 1000) * 1000)).padStart(6, '0')}`;
    for (const [bus, id, payload] of frames(i, pages)) lines.push(`(${stamp}) ${bus} ${id}#${payload}`);
  }
  return `${lines.join('\n')}\n`;
}

// what the car says at that moment (by hand from the frames above)
const EXPECTED = {
  VCRIGHT_hvacCabinTempEst: 22.5, // C
  v12vBattVoltage261: 15.77, // V (rounded)
  BMS_nominalFullPackEnergy: 67.54, // kWh
  BMS_nominalEnergyRemaining: 59.92,
  BMS_idealEnergyRemaining: 59.7,
  BMS_fullChargeComplete: 1,
  BMS_energyBuffer: 3.04,
  BMS_expectedEnergyRemaining: 59.7,
  BMS_energyToChargeComplete: 1.18,
  BattBrickTempMax332: 21.5,
  BattBrickTempMin332: 21,
  BattBrickVoltageMax332: 4.104,
  VCSEC_TPMSPressure0: 2.575, // bar
  VCSEC_TPMSPressure1: 2.55,
  VCSEC_TPMSPressure2: 2.5,
  VCSEC_TPMSPressure3: 2.5,
  VCSEC_TPMSRecommendedPressure0: 2.9,
  UI_gpsHDOP: 0,
  SOCUI292: 88.7, // % (59.92 / 67.54 kWh is 88.7 %)
  UI_cpuTemperature_353: 30,
  UI_cpuTemperature_00C: 50
};

/**
 * 0x04F's payload for a position (model3dbc: latitude bits 0-27 and longitude 28-55, signed, a
 * millionth of a degree; accuracy bits 57-63, 0.2 m; Intel byte order), bit 56 as the car sent it.
 */
function gps04F(lat, lon, acc) {
  const real = Buffer.from(PAGES['can3:04F'][0], 'hex').readBigUInt64LE();
  const bits = (v, n) => BigInt.asUintN(n, BigInt(Math.round(v)));
  const v = bits(lat * 1e6, 28) | (bits(lon * 1e6, 28) << 28n) | (real & (1n << 56n)) | (bits(acc / 0.2, 7) << 57n);
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(v);
  return b.toString('hex').toUpperCase();
}

// Messages model3dbc lacks, from opendbc (server/dbc/model3y-opendbc.dbc), as the same car sent
// them (each frame's checksum right), with what they say: the steering about 6 degrees (as parked),
// no hands on the wheel, the 12 V supply as 0x261 reads it.
const OPENDBC_PAGES = {
  'can1:370': ['11FE07F1203904D7', '11FE07F1203902D5'],
  'can1:488': ['403A0D1300000000', '403A070D00000000'],
  'can0:343': ['329364FEB5008000', '3293642EB6008000']
};
const OPENDBC_EXPECTED = {
  EPAS3S_internalSAS: 5.7, // deg
  EPAS3S_torsionBarTorque: -0.17, // Nm
  EPAS3S_steeringRackForce: -75, // N
  EPAS3S_eacStatus: 0, // EAC_INHIBITED
  EPAS3S_steeringFault: 0,
  DAS_steeringAngleRequest: 5.85, // deg
  DAS_steeringControlType: 0, // NONE
  VCRIGHT_vbatProt: 15.8465, // V
  VCRIGHT_5AVoltage: 5.0136, // V
  VCRIGHT_rearDefrostState: 2, // HEATER_STATE_OFF
  VCRIGHT_mirrorHeatState: 2
};

module.exports = { PAGES, frames, candump, gps04F, EXPECTED, OPENDBC_PAGES, OPENDBC_EXPECTED };
