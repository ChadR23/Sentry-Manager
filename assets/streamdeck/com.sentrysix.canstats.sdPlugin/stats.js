// The stats GET /api/can/now gives (server/canNow.js STATS), for the key picker
// (pi.html) and the plugin (bin/plugin.js, Node).
var CAN_STATS = [
  ['speed', 'Speed'], ['battery', 'Battery'], ['range', 'Range'], ['batteryPower', 'Battery power'], ['gear', 'Gear'],
  ['batteryVoltage', 'Battery voltage'], ['batteryCurrent', 'Battery current'], ['batteryTemp', 'Battery temp'],
  ['outsideTemp', 'Outside temp'], ['cabinTemp', 'Cabin temp'], ['batteryInletTemp', 'Battery inlet temp'],
  ['powertrainInletTemp', 'Powertrain inlet temp'], ['rearMotorPower', 'Rear motor power'],
  ['frontMotorPower', 'Front motor power'], ['rearMotorTemp', 'Rear motor temp'], ['frontMotorTemp', 'Front motor temp'],
  ['lv12Current', '12V system current'], ['lv12Power', '12V system power'], ['lv12Voltage', '12V battery'],
  ['lv12State', '12V battery state'], ['tire1', 'Tire 1'], ['tire2', 'Tire 2'], ['tire3', 'Tire 3'], ['tire4', 'Tire 4'],
  ['charging', 'Charging'], ['chargingPower', 'Charging power'], ['chargeTimeLeft', 'Charge time left'],
  ['energyRemaining', 'Energy remaining'], ['odometer', 'Odometer'], ['setSpeed', 'Set speed'],
  ['speedLimit', 'Speed limit'], ['elevation', 'Elevation']
];
if (typeof window !== 'undefined') window.CAN_STATS = CAN_STATS;
if (typeof module !== 'undefined' && module.exports) module.exports = { CAN_STATS };
