'use strict';

// The devices a conversion can encode on: every Intel/AMD render node the
// container has, every NVIDIA GPU nvidia-smi lists, and the CPU (always last).
// A device is named by its PCI slot, never by its node: the compose remap
// trick (/dev/dri/renderD129:/dev/dri/renderD128) and a reboot both change
// node names, the slot stays. Only ids from this list are ever used; a node
// path or an NVIDIA index never comes from the browser.

const nodeFs = require('fs');
const nodePath = require('path');

const PCI_SLOT = /^[0-9a-f]{4}:[0-9a-f]{2}:[0-9a-f]{2}\.[0-7]$/i;
const DRI_VENDORS = Object.freeze({ '0x8086': 'intel', '0x1002': 'amd' });
const VENDOR_LABELS = Object.freeze({ intel: 'Intel', amd: 'AMD', nvidia: 'NVIDIA' });
const NVIDIA_TIMEOUT_MS = 10_000;
// The runner stops nvidia-smi at its timeout but answers only once it has
// exited, which one stuck in a wedged driver never does: the list does not
// wait for it past this.
const NVIDIA_DEADLINE_MS = NVIDIA_TIMEOUT_MS + 2_000;
const CPU_DEVICE = Object.freeze({
  id: 'cpu', kind: 'cpu', vendor: null, name: 'CPU (software encoder)', node: null, index: null, pci: null
});

// Character device numbers of a node, as the kernel encodes them in st_rdev.
function defaultStatRdev(fs) {
  return (target) => {
    const rdev = Number(fs.statSync(target).rdev);
    if (!Number.isSafeInteger(rdev) || rdev <= 0) return null;
    return { major: (rdev >> 8) & 0xfff, minor: (rdev & 0xff) | ((rdev >> 12) & 0xfff00) };
  };
}

// "00000000:01:00.0" (nvidia-smi) or "0000:03:00.0" -> "0000:03:00.0"
function normalizePciSlot(value) {
  const slot = String(value || '').trim().toLowerCase().slice(-12);
  return PCI_SLOT.test(slot) ? slot : null;
}

function fallbackName(vendor, pci) {
  return `${VENDOR_LABELS[vendor] || 'Unknown'} GPU (${pci})`;
}

function createDeviceDiscovery({
  fs = nodeFs,
  pathApi = nodePath,
  platform = process.platform,
  devRoot = '/dev',
  sysRoot = '/sys',
  runCommand,
  statRdev,
  nameOf,
  nvidiaDeadlineMs = NVIDIA_DEADLINE_MS
} = {}) {
  const pfs = fs.promises || fs;
  const rdevOf = statRdev === undefined ? defaultStatRdev(fs) : statRdev;

  const readLine = async (target) => {
    try { return String(await pfs.readFile(target, 'utf8')).trim(); } catch (_) { return null; }
  };
  const realPath = async (target) => {
    try { return await pfs.realpath(target); } catch (_) { return null; }
  };

  // The PCI device behind a render node: through its char device number
  // (true whatever the node is called inside the container), else through
  // its name in /sys/class/drm.
  async function sysDeviceOf(node, name) {
    if (typeof rdevOf === 'function') {
      try {
        const numbers = rdevOf(node);
        if (numbers && Number.isSafeInteger(numbers.major) && Number.isSafeInteger(numbers.minor)) {
          const found = await realPath(pathApi.join(sysRoot, 'dev', 'char', `${numbers.major}:${numbers.minor}`, 'device'));
          if (found) return found;
        }
      } catch (_) { /* by name below */ }
    }
    return realPath(pathApi.join(sysRoot, 'class', 'drm', name, 'device'));
  }

  function displayName(info) {
    if (typeof nameOf === 'function') {
      try {
        const name = nameOf(info);
        if (typeof name === 'string' && name.trim()) return name.trim().slice(0, 128);
      } catch (_) { /* the plain name below */ }
    }
    return fallbackName(info.vendor, info.pci);
  }

  async function driDevices() {
    let names;
    try { names = await pfs.readdir(pathApi.join(devRoot, 'dri')); } catch (_) { return []; }
    const renders = names.filter((name) => /^renderD\d+$/.test(name))
      .sort((left, right) => Number(left.slice(7)) - Number(right.slice(7)));
    const devices = [];
    for (const name of renders) {
      const node = pathApi.join(devRoot, 'dri', name);
      const sysDevice = await sysDeviceOf(node, name);
      if (!sysDevice) continue;
      // SoC GPUs (a Raspberry Pi's V3D, ...) are not PCI devices
      const slot = pathApi.basename(sysDevice);
      if (!PCI_SLOT.test(slot)) continue;
      const pci = slot.toLowerCase();
      const vendorId = (await readLine(pathApi.join(sysDevice, 'vendor')))?.toLowerCase() || null;
      const vendor = DRI_VENDORS[vendorId] || null;
      if (!vendor) continue;
      let driver = null;
      try { driver = pathApi.basename(await pfs.readlink(pathApi.join(sysDevice, 'driver'))); } catch (_) { driver = null; }
      // NVIDIA's own driver also has render nodes; NVENC covers those GPUs
      if (driver === 'nvidia') continue;
      // the same GPU mapped in twice (under its own name and a remapped one)
      if (devices.some((device) => device.pci === pci)) continue;
      const deviceId = (await readLine(pathApi.join(sysDevice, 'device')))?.toLowerCase() || null;
      devices.push(Object.freeze({
        id: `pci:${pci}`, kind: 'dri', vendor,
        name: displayName({ pci, vendor, vendorId, deviceId, driver, sysDevice }),
        node, index: null, pci
      }));
    }
    return devices;
  }

  // an nvidia-smi still stuck past its deadline: no other one is started
  let stuck = null;
  async function nvidiaDevices() {
    if (typeof runCommand !== 'function' || stuck) return [];
    let result;
    let timer;
    try {
      const running = Promise.resolve().then(() => runCommand('nvidia-smi', ['--query-gpu=index,pci.bus_id,name', '--format=csv,noheader'], {
        timeoutMs: NVIDIA_TIMEOUT_MS, windowsHide: true, shell: false
      }));
      const late = {};
      result = await Promise.race([running, new Promise((resolve) => { timer = setTimeout(() => resolve(late), nvidiaDeadlineMs); })]);
      if (result === late) {
        stuck = running;
        running.catch(() => {}).finally(() => { if (stuck === running) stuck = null; });
        return [];
      }
    } catch (_) { return []; } finally { clearTimeout(timer); }
    if (!result || result.status !== 0 || result.error || result.timedOut) return [];
    const devices = [];
    for (const line of String(result.stdout || '').split(/\r?\n/)) {
      const parts = line.split(',').map((part) => part.trim());
      if (parts.length < 3 || !/^\d+$/.test(parts[0])) continue;
      const index = Number(parts[0]);
      const pci = normalizePciSlot(parts[1]);
      if (!Number.isSafeInteger(index) || !pci || devices.some((device) => device.pci === pci)) continue;
      const name = parts.slice(2).join(', ').slice(0, 128) || fallbackName('nvidia', pci);
      devices.push(Object.freeze({ id: `pci:${pci}`, kind: 'nvidia', vendor: 'nvidia', name, node: null, index, pci }));
    }
    return devices.sort((left, right) => left.index - right.index);
  }

  return Object.freeze({
    async list() {
      if (platform !== 'linux') return [CPU_DEVICE];
      const dri = await driDevices().catch(() => []);
      const nvidia = (await nvidiaDevices().catch(() => [])).filter((device) => !dri.some((other) => other.id === device.id));
      return [...dri, ...nvidia, CPU_DEVICE];
    }
  });
}

module.exports = { createDeviceDiscovery, normalizePciSlot, CPU_DEVICE };
