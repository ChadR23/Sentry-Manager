'use strict';

// The kind of host the Manager runs on, for the heartbeat's `host` field
// (server/reportsProtocol.js HEARTBEAT_HOST_OS, docs/reports-api.md): one
// word from a fixed list (or null) and whether it runs in a container.
// Nothing else leaves this module: never the kernel string, the host name or
// the OS version, only the word.
//
// In a container, /etc/os-release is the image's (Debian, Alpine...), not the
// host's, but the kernel is the host's, so its release string tells the host:
//   -production+truenas / truenas   truenas (TrueNAS SCALE)
//   -Unraid / unraid                unraid
//   microsoft-standard-WSL2 / microsoft   wsl (Docker Desktop on Windows, WSL2)
//   linuxkit                        Docker Desktop's own VM: a guess, since
//                                   the kernel string is the same on both:
//                                   macos on arm64 (Apple Silicon Macs),
//                                   else wsl (Windows with the Hyper-V
//                                   backend; an Intel Mac reads as wsl too)
//   a Raspberry Pi device-tree model (the device tree is the host's), or
//   rpi / raspi in the kernel        raspberry-pi (v8+ alone is not enough:
//                                   it needs the model)
//   synology (kernel, /proc/version) or DSM's /proc/sys/kernel/syno_hw_version
//                                   synology
//   qnap                            qnap
//   anything else                   linux
// Outside a container the same kernel and device-tree signs come first (TrueNAS
// SCALE and Raspberry Pi OS call themselves debian in os-release), then
// /etc/os-release's ID, else the first of its ID_LIKE we know (Linux Mint is
// ubuntu, Rocky is fedora), else linux; macOS is macos; any other platform
// (Windows itself) is null.

const fsDefault = require('fs');
const osDefault = require('os');

const CONTAINER_RE = /docker|containerd|kubepods|libpod/i;
const PI_MODEL_FILES = ['/proc/device-tree/model', '/sys/firmware/devicetree/base/model'];
const OS_RELEASE_FILES = ['/etc/os-release', '/usr/lib/os-release'];
// os-release ids we name (raspbian is the Raspberry Pi's own Debian)
const OS_IDS = { ubuntu: 'ubuntu', debian: 'debian', fedora: 'fedora', raspbian: 'raspberry-pi', truenas: 'truenas', unraid: 'unraid', 'unraid-os': 'unraid' };

function reader(fs) {
  return (p) => {
    try { return String(fs.readFileSync(p, 'utf8')); } catch { return ''; }
  };
}
const exists = (fs, p) => { try { return fs.existsSync(p); } catch { return false; } };

/** Whether this process runs in a container (Docker, containerd, Kubernetes, Podman). */
function inContainer({ fs = fsDefault } = {}) {
  if (exists(fs, '/.dockerenv')) return true;
  const read = reader(fs);
  return CONTAINER_RE.test(read('/proc/1/cgroup')) || CONTAINER_RE.test(read('/proc/self/mountinfo'));
}

/** The key=value lines of an os-release file ({ ID, ID_LIKE, ... }, quotes off). */
function parseOsRelease(text) {
  const out = {};
  for (const line of String(text || '').split('\n')) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (m) out[m[1]] = m[2].replace(/^(["'])(.*)\1$/, '$2');
  }
  return out;
}

/** What the kernel (and device tree) say, or null when they say nothing we know. */
function fromKernel({ release, version, arch, piModel, synoFile }) {
  const k = `${release} ${version}`;
  if (/truenas/i.test(k)) return 'truenas';
  if (/unraid/i.test(k)) return 'unraid';
  if (/microsoft/i.test(k)) return 'wsl';
  if (/linuxkit/i.test(k)) return arch === 'arm64' ? 'macos' : 'wsl';
  if (piModel || /rpi|raspi/i.test(k)) return 'raspberry-pi';
  if (/synology/i.test(k) || synoFile) return 'synology';
  if (/qnap/i.test(k)) return 'qnap';
  return null;
}

/** { os, docker } for this host (fs and os injectable for tests). */
function detectHost({ fs = fsDefault, os = osDefault, platform = process.platform, arch = process.arch } = {}) {
  const docker = inContainer({ fs });
  if (platform === 'darwin') return { os: 'macos', docker };
  if (platform !== 'linux') return { os: null, docker };
  const read = reader(fs);
  let release = '';
  try { release = String(os.release() || ''); } catch { /* none */ }
  const signs = {
    release, version: read('/proc/version'), arch,
    piModel: PI_MODEL_FILES.some((p) => /Raspberry Pi/i.test(read(p))),
    synoFile: exists(fs, '/proc/sys/kernel/syno_hw_version')
  };
  const kernel = fromKernel(signs);
  if (kernel || docker) return { os: kernel || 'linux', docker };
  const rel = parseOsRelease(OS_RELEASE_FILES.map(read).find(Boolean));
  const ids = [rel.ID, ...String(rel.ID_LIKE || '').split(/\s+/)].map((x) => String(x || '').toLowerCase()).filter(Boolean);
  const id = ids.find((x) => Object.hasOwn(OS_IDS, x));
  return { os: id ? OS_IDS[id] : 'linux', docker };
}

let cached = null;
/** The host, worked out once (it does not change while the app runs). */
function hostInfo() {
  if (!cached) {
    try { cached = detectHost(); } catch { cached = { os: null, docker: false }; }
  }
  return { ...cached };
}

module.exports = { hostInfo, detectHost, inContainer, parseOsRelease };
