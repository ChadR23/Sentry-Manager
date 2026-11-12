'use strict';

// What graphics hardware the container can see, for the Settings / Encoder
// pages. The converter's own planner decides which encoder is used (it test-
// encodes each candidate); this only explains what is there and why a GPU
// might not be used.

const fs = require('fs');
const path = require('path');
const { run } = require('./proc');

const VENDORS = { '0x1002': 'amd', '0x10de': 'nvidia', '0x8086': 'intel' };
const VENDOR_NAMES = { amd: 'AMD', nvidia: 'NVIDIA', intel: 'Intel' };

function readSys(p) {
  try {
    return fs.readFileSync(p, 'utf8').trim();
  } catch {
    return null;
  }
}

/** Parse `vainfo` output into a driver name and the codecs it can encode. */
function parseVainfo(text) {
  const driver = (text.match(/Driver version:\s*(.+)/) || [])[1]?.trim() || null;
  const enc = (profile) => new RegExp(`${profile}\\s*:\\s*VAEntrypointEncSlice(LP)?\\b`).test(text);
  const lpOnly = (profile) => new RegExp(`${profile}\\s*:\\s*VAEntrypointEncSliceLP`).test(text)
    && !new RegExp(`${profile}\\s*:\\s*VAEntrypointEncSlice\\b(?!LP)`).test(text);
  return {
    driver,
    encodes: {
      h264: enc('VAProfileH264(High|Main|ConstrainedBaseline)'),
      hevc: enc('VAProfileHEVCMain'),
      av1: enc('VAProfileAV1Profile0')
    },
    lowPowerOnly: lpOnly('VAProfileHEVCMain')
  };
}

/** A friendly GPU name out of the VA driver string, e.g. "AMD Radeon Graphics (renoir)". */
function nameFromDriver(driver) {
  if (!driver) return null;
  const m = driver.match(/for (AMD [^(]+)\(radeonsi, ([a-z0-9_]+)/i);
  if (m) return `${m[1].trim()} (${m[2]})`;
  if (/Intel iHD driver/i.test(driver)) return 'Intel graphics (iHD)';
  return driver.slice(0, 80);
}

// Windows (WSL): a render node backed by Microsoft's D3D12 bridge (Mesa's
// d3d12 driver over /dev/dxg). It is no GPU of its own and is not used for
// encoding; NVIDIA cards encode through the NVIDIA Container Toolkit instead.
const isWslBridge = (driver, dxgDevice) => /d3d12/i.test(driver || '') || (dxgDevice && !driver);

async function detectGpus({ driDir = '/dev/dri', sysDrm = '/sys/class/drm', dxg = '/dev/dxg', runImpl = run, procVersion = '/proc/version', arch = process.arch } = {}) {
  const wsl = fs.existsSync(dxg);
  const gpus = [];
  let passed = [];
  try {
    passed = fs.readdirSync(driDir).filter((n) => /^renderD\d+$/.test(n)).sort();
  } catch {
    passed = [];
  }
  // sysfs is not namespaced: it lists the host's GPUs even when /dev/dri is not passed in.
  let hostNodes = [];
  try {
    hostNodes = fs.readdirSync(sysDrm).filter((n) => /^renderD\d+$/.test(n)).sort();
  } catch {
    hostNodes = [];
  }
  for (const node of [...new Set([...hostNodes, ...passed])]) {
    const vendorId = readSys(path.join(sysDrm, node, 'device', 'vendor'));
    const vendor = VENDORS[vendorId] || null;
    // no AMD, Intel or NVIDIA device behind it and not passed in: nothing
    // that could encode here (on Windows/WSL, the D3D12 bridge), so not listed
    if (!vendor && !passed.includes(node)) continue;
    let driverName = null;
    try {
      driverName = path.basename(fs.readlinkSync(path.join(sysDrm, node, 'device', 'driver')));
    } catch {
      driverName = null;
    }
    const entry = {
      node: `/dev/dri/${node}`, vendor, vendorName: VENDOR_NAMES[vendor] || vendorId || 'unknown', driver: driverName,
      name: null, passedThrough: passed.includes(node), encodes: null, lowPowerOnly: false
    };
    if (entry.passedThrough && vendor !== 'nvidia') {
      const va = await runImpl('vainfo', ['--display', 'drm', '--device', entry.node], { timeoutMs: 10000 });
      let driver = null;
      if (va.code === 0 || va.stdout) {
        const info = parseVainfo(`${va.stdout}\n${va.stderr}`);
        driver = info.driver;
        entry.name = nameFromDriver(info.driver);
        entry.encodes = info.encodes;
        entry.lowPowerOnly = info.lowPowerOnly;
      }
      if (!vendor && isWslBridge(driver, wsl)) {
        entry.virtual = true;
        entry.name = 'Windows (WSL) graphics bridge';
        entry.encodes = null;
      }
    }
    gpus.push(entry);
  }
  const smi = await runImpl('nvidia-smi', ['--query-gpu=name,driver_version', '--format=csv,noheader'], { timeoutMs: 10000 });
  const nvidia = smi.code === 0
    ? smi.stdout.trim().split('\n').filter(Boolean).map((l) => {
      const [name, driver] = l.split(',').map((s) => s.trim());
      return { name, driver };
    })
    : [];
  const hints = [];
  for (const g of gpus) {
    if (g.virtual) continue;
    if (!g.passedThrough && g.vendor !== 'nvidia') hints.push(`${g.vendorName} GPU found on the host but /dev/dri is not passed into the container (add devices: - /dev/dri:/dev/dri).`);
    if (g.passedThrough && g.encodes && !g.encodes.hevc) hints.push(`${g.name || g.node}: the VA-API driver reports no H.265 encoder.`);
  }
  if (gpus.some((g) => g.vendor === 'nvidia') && !nvidia.length) {
    hints.push('An NVIDIA GPU is on the host but not available in the container. Use the NVIDIA Container Toolkit (gpus: all) with NVIDIA_DRIVER_CAPABILITIES=compute,video,utility.');
  }
  // Docker Desktop runs containers in a Linux VM (its kernel says linuxkit).
  // On a Mac that VM never sees the Mac's GPU: Apple offers no way to pass
  // it to Linux, so no setting here can turn it on.
  if (!gpus.some((g) => g.passedThrough && !g.virtual) && !nvidia.length) {
    let kernel = '';
    try {
      kernel = fs.readFileSync(procVersion, 'utf8');
    } catch {
      kernel = '';
    }
    if (/linuxkit/i.test(kernel)) {
      hints.push(arch === 'arm64'
        ? 'Running in Docker Desktop, likely on an Apple Silicon Mac: Docker cannot use a Mac\'s GPU (macOS does not share it with the Linux virtual machine containers run in), so conversions use the CPU encoder. A Linux or Windows computer with a GPU can encode for this server as a node (Nodes).'
        : 'Running in Docker Desktop: its Linux virtual machine sees no GPU. On Windows, an NVIDIA GPU works with WSL 2 and gpus: all; on a Mac no GPU can be used, so conversions use the CPU encoder.');
    }
  }
  return { gpus, nvidia, hints };
}

/**
 * The GPUs this container can use, from detectGpus()'s { gpus, nvidia } (or
 * a plain list, which is taken as it is): the /dev/dri ones passed in (not
 * Windows' graphics bridge; NVIDIA's are left to nvidia-smi) and the NVIDIA
 * ones in the container. The set the Health check counts and the heartbeat
 * names: [{ name, vendor }].
 */
function usableGpus(found) {
  if (Array.isArray(found)) return found.filter(Boolean);
  return [
    ...(found?.gpus || []).filter((g) => g && g.passedThrough && !g.virtual && g.vendor !== 'nvidia')
      .map((g) => ({ ...g, name: g.name || `${g.vendorName || 'Unknown'} GPU` })),
    ...(found?.nvidia || []).filter(Boolean).map((g) => ({ ...g, name: g.name || 'NVIDIA GPU', vendor: 'nvidia' }))
  ];
}

// the vendor an encoder API runs on, when it says (nvenc NVIDIA, qsv Intel, amf AMD)
const API_VENDOR = { nvenc: 'nvidia', qsv: 'intel', amf: 'amd' };

/**
 * The name of the GPU an encode used, exactly as usableGpus(found) names it
 * (the heartbeat's `gpus`), so `convert.device` is one of them:
 * - device: the render node it opened ('/dev/dri/renderD128': VA-API, or
 *   QSV/AMF on a chosen GPU) or an NVIDIA GPU by index ('nvidia1', the
 *   converter's -gpu); api: its encoder's API (nvenc, vaapi, qsv, amf, ...);
 *   vendor: the GPU's maker when known (amd, intel, nvidia).
 * - without a device: the GPU ffmpeg takes by default for that API (the first
 *   NVIDIA GPU for NVENC, renderD128 for VA-API, the first Intel/AMD one for
 *   QSV/AMF), and the only GPU there is when it is just one.
 * - no match: a generic "NVIDIA GPU" / "Intel GPU" / "AMD GPU" / "GPU".
 */
function encodeGpuName(found, { device = null, api = null, vendor = null } = {}) {
  const usable = usableGpus(found);
  const nvidia = usable.filter((g) => g.vendor === 'nvidia');
  const dri = usable.filter((g) => g.vendor !== 'nvidia' && typeof g.node === 'string');
  const dev = typeof device === 'string' ? device : '';
  const nv = /^nvidia(\d+)$/.exec(dev);
  if (nv && nvidia[Number(nv[1])]) return nvidia[Number(nv[1])].name;
  const render = /(?:^|\/)(renderD\d+)$/.exec(dev)?.[1];
  if (render) {
    const g = dri.find((x) => path.basename(x.node) === render);
    if (g) return g.name;
  }
  if (!dev) {
    const maker = API_VENDOR[api] || null;
    const pick = maker === 'nvidia' ? nvidia[0]
      : maker ? dri.find((g) => g.vendor === maker)
        : api === 'vaapi' ? dri.find((g) => path.basename(g.node) === 'renderD128') || dri[0]
          : null;
    if (pick) return pick.name;
    // a GPU of that maker (or any, when the API does not say) and only one
    const same = usable.filter((g) => !maker || g.vendor === maker);
    if (usable.length === 1 && same.length === 1) return usable[0].name;
  }
  const maker = vendor || API_VENDOR[api] || null;
  return VENDOR_NAMES[maker] ? `${VENDOR_NAMES[maker]} GPU` : 'GPU';
}

module.exports = { detectGpus, parseVainfo, nameFromDriver, usableGpus, encodeGpuName };
