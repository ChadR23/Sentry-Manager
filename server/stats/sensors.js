'use strict';

// Every temperature and fan the board reports (/sys/class/hwmon), plus the
// thermal zones when no hwmon chip covers the CPU (Raspberry Pi and other
// ARM boards). Sensor reads go through BackgroundReads: some ask the device
// itself (drivetemp sends the disk a command), and the CPU's are read every
// sample while the rest are read every 10-30 s.

const path = require('path');
const { readLine, listDir, realPath, num, join } = require('./util');

const CPU_CHIP = /^(coretemp|k10temp|zenpower|cpu[_-]?thermal|cpu\d*[_-]thermal|soc[_-]?thermal)$/;
const CPU_ZONE = /x86_pkg_temp|cpu|soc/i;
const EVERY = { cpu: 0, gpu: 0, nvme: 10000, drivetemp: 30000, other: 10000 };
const MAX_AGE = 90000; // an answer older than this (a hung sensor) is not shown

/** A plausible temperature in °C from millidegrees; unplugged inputs read -128, 127, 255... */
function tempC(text) {
  const v = num(text);
  if (v === null) return null;
  const c = v / 1000;
  return c > -30 && c < 127 ? Math.round(c * 10) / 10 : null;
}

function chipFiles(dir) {
  const files = listDir(dir, 512);
  const temps = [];
  const fans = [];
  for (const f of files) {
    let m = /^temp(\d+)_input$/.exec(f);
    if (m) temps.push({ n: Number(m[1]), file: join(dir, f), label: readLine(join(dir, `temp${m[1]}_label`)) });
    m = /^fan(\d+)_input$/.exec(f);
    if (m) fans.push({ n: Number(m[1]), file: join(dir, f), label: readLine(join(dir, `fan${m[1]}_label`)) });
  }
  temps.sort((a, b) => a.n - b.n);
  fans.sort((a, b) => a.n - b.n);
  return { files: new Set(files), temps, fans };
}

class SensorsProvider {
  constructor({ sysRoot, reads }) {
    this.sysRoot = sysRoot;
    this.reads = reads;
    this.chips = [];
    this.zones = [];
    this.cpuChip = null;
    this.cpuZone = null;
    this.fansSeen = new Set();
  }

  probe() {
    // which disk a drive sensor belongs to: drivetemp hangs off the SCSI
    // device, nvme off the controller
    const blockDevs = listDir(join(this.sysRoot, 'block')).map((name) => ({ name, dev: realPath(join(this.sysRoot, 'block', name, 'device')) }));
    const hwmonDir = join(this.sysRoot, 'class', 'hwmon');
    this.chips = [];
    for (const id of listDir(hwmonDir).filter((n) => /^hwmon\d+$/.test(n)).sort((a, b) => Number(a.slice(5)) - Number(b.slice(5)))) {
      const dir = join(hwmonDir, id);
      const name = readLine(join(dir, 'name')) || id;
      const dev = realPath(join(dir, 'device'));
      const chip = { id, dir, name, dev, ...chipFiles(dir), disk: null, role: 'other' };
      if (CPU_CHIP.test(name)) chip.role = 'cpu';
      else if (name === 'drivetemp') {
        chip.role = 'drivetemp';
        chip.disk = blockDevs.find((b) => b.dev && b.dev === dev)?.name || null;
      } else if (name === 'nvme') {
        chip.role = 'nvme';
        const ctrl = dev ? path.basename(dev) : null;
        chip.disk = (ctrl && blockDevs.map((b) => b.name).filter((n) => n.startsWith(`${ctrl}n`)).sort()[0]) || ctrl;
      }
      this.chips.push(chip);
    }
    this.cpuChip = this.chips.find((c) => c.role === 'cpu' && c.temps.length) || null;
    const zoneDir = join(this.sysRoot, 'class', 'thermal');
    this.zones = listDir(zoneDir).filter((n) => /^thermal_zone\d+$/.test(n))
      .sort((a, b) => Number(a.slice(12)) - Number(b.slice(12)))
      .map((z) => ({ id: z, type: readLine(join(zoneDir, z, 'type')) || z, file: join(zoneDir, z, 'temp') }));
    this.cpuZone = this.zones.find((z) => /x86_pkg_temp/.test(z.type)) || this.zones.find((z) => CPU_ZONE.test(z.type)) || null;
  }

  /** Mark the hwmon chips that belong to a GPU (read every sample, not every 10 s). */
  markGpuChips(devReals) {
    for (const c of this.chips) if (c.role === 'other' && c.dev && devReals.includes(c.dev)) c.role = 'gpu';
  }

  value(file, role) {
    return this.reads.text(file, EVERY[role] ?? EVERY.other, MAX_AGE);
  }

  chipTemp(chip, t) {
    return tempC(this.value(t.file, chip.role));
  }

  /** CPU temperature: coretemp package, k10temp Tdie/Tctl, or the CPU thermal zone. */
  cpuTemp() {
    const c = this.cpuChip;
    if (c) {
      const pick = (re) => c.temps.filter((t) => t.label && re.test(t.label));
      let list = pick(/^Package id \d+$/);
      if (!list.length) list = pick(/^Tdie$/);
      if (!list.length) list = pick(/^Tctl$/);
      if (!list.length) list = pick(/^Core \d+$/);
      if (!list.length) list = c.temps.slice(0, 1);
      let best = null;
      for (const t of list) {
        const v = this.chipTemp(c, t);
        if (v !== null && (best === null || v > best)) best = v;
      }
      return best;
    }
    if (this.cpuZone) return tempC(this.value(this.cpuZone.file, 'cpu'));
    return null;
  }

  /** Temperature of a disk's own sensor, by disk name. */
  diskTemp(disk) {
    const c = this.chips.find((ch) => ch.disk === disk && (ch.role === 'nvme' || ch.role === 'drivetemp'));
    if (!c || !c.temps.length) return null;
    // NVMe: "Composite" is the drive's own figure
    const t = c.temps.find((x) => x.label === 'Composite') || c.temps[0];
    return this.chipTemp(c, t);
  }

  /** The hwmon chip of a device (a GPU), if any. */
  chipOf(devReal) {
    return devReal ? this.chips.find((c) => c.dev === devReal) || null : null;
  }

  list() {
    const out = [];
    const ordered = [...this.chips].sort((a, b) => (a.role === 'cpu' ? 0 : 1) - (b.role === 'cpu' ? 0 : 1));
    for (const c of ordered) {
      for (const t of c.temps) {
        const value = this.chipTemp(c, t);
        if (value === null) continue;
        let label = t.label || `temp${t.n}`;
        if (c.disk) label = t.label && t.label !== 'Composite' ? `${c.disk} ${t.label}` : c.disk;
        out.push({ chip: c.name, label, kind: 'temp', value });
      }
      for (const f of c.fans) {
        const value = num(this.value(f.file, c.role));
        if (value === null || value < 0 || value > 50000) continue;
        // unconnected fan headers read 0 forever; a fan that ever spun stays listed
        if (value > 0) this.fansSeen.add(f.file);
        if (!this.fansSeen.has(f.file)) continue;
        out.push({ chip: c.name, label: f.label || `Fan ${f.n}`, kind: 'fan', value });
      }
    }
    if (!this.cpuChip) {
      for (const z of this.zones) {
        const value = tempC(this.value(z.file, z === this.cpuZone ? 'cpu' : 'other'));
        if (value !== null) out.push({ chip: z.type, label: z === this.cpuZone ? 'CPU' : z.type, kind: 'temp', value });
      }
    }
    return out;
  }
}

module.exports = { SensorsProvider, tempC };
