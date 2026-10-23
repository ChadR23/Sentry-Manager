'use strict';

// The server line of the Server section: host name, OS, kernel, uptimes and
// versions. Inside a container /etc/os-release describes the image, not the
// server, so the OS is told from the kernel's own build string instead.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { readLine, readText, join } = require('./util');

const APP_ROOT = path.join(__dirname, '..', '..');

/** The host's distribution, as far as its kernel build string tells. */
function osFromKernel(release, version) {
  const s = `${release || ''} ${version || ''}`;
  const tests = [
    [/unraid/i, 'Unraid'], [/truenas/i, 'TrueNAS'], [/-pve\b|proxmox/i, 'Proxmox VE'], [/synology/i, 'Synology DSM'],
    [/qnap/i, 'QNAP QTS'], [/microsoft|WSL/i, 'Windows (WSL)'], [/rpt-rpi|raspberrypi|\+rpt/i, 'Raspberry Pi OS'],
    [/ubuntu/i, 'Ubuntu'], [/debian|\+deb\d+/i, 'Debian'], [/\.fc\d+\./i, 'Fedora'], [/\.el\d+/i, 'Enterprise Linux'],
    [/-arch\d|archlinux/i, 'Arch Linux'], [/manjaro/i, 'Manjaro'], [/gentoo/i, 'Gentoo'], [/alpine|-lts\b/i, 'Alpine'],
    [/nixos/i, 'NixOS'], [/suse/i, 'openSUSE'], [/talos/i, 'Talos'], [/linuxkit/i, 'Docker Desktop']
  ];
  for (const [re, name] of tests) if (re.test(s)) return name;
  return release ? 'Linux' : null;
}

/** The running build: the commit from BUILD_INFO.json (release images), else version.json. */
function appVersion(root = APP_ROOT) {
  try {
    const sha = JSON.parse(fs.readFileSync(join(root, 'BUILD_INFO.json'), 'utf8')).sha;
    if (sha) return String(sha).slice(0, 7);
  } catch {
    // a development checkout
  }
  try {
    return JSON.parse(fs.readFileSync(join(root, 'version.json'), 'utf8')).version || null;
  } catch {
    return null;
  }
}

/** "ffmpeg version 7.1.1-Jellyfin Copyright ..." -> "7.1.1-Jellyfin" */
function parseFfmpegVersion(text) {
  const m = /ffmpeg version (\S+)/.exec(String(text || ''));
  return m ? m[1] : null;
}

/** Ask ffmpeg its version once, without blocking; resolves null when it cannot tell. */
function probeFfmpeg({ spawn, ffmpegPath, timers }) {
  return new Promise((resolve) => {
    let out = '';
    let done = false;
    let timer = null;
    const finish = (v) => {
      if (done) return;
      done = true;
      if (timer) timers.clearTimeout(timer);
      resolve(v);
    };
    let child;
    try {
      child = spawn(ffmpegPath, ['-hide_banner', '-version'], { stdio: ['ignore', 'pipe', 'ignore'] });
    } catch {
      finish(null);
      return;
    }
    timer = timers.setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        // gone
      }
      finish(null);
    }, 10000);
    timer?.unref?.();
    child.on('error', () => finish(null));
    child.stdout?.on('data', (c) => {
      if (out.length < 4096) out += c;
    });
    child.on('close', () => finish(parseFfmpegVersion(out)));
  });
}

class HostInfo {
  constructor({ procRoot, version }) {
    this.procRoot = procRoot;
    this.version = version === undefined ? appVersion() : version;
    this.static = null;
  }

  probe() {
    const kernel = readLine(join(this.procRoot, 'sys', 'kernel', 'osrelease'));
    this.static = {
      hostname: readLine(join(this.procRoot, 'sys', 'kernel', 'hostname')) || os.hostname() || null,
      os: osFromKernel(kernel, readText(join(this.procRoot, 'version'))),
      kernel,
      arch: readLine(join(this.procRoot, 'sys', 'kernel', 'arch')) || (typeof os.machine === 'function' ? os.machine() : os.arch()),
      version: this.version,
      node: process.version
    };
  }

  info({ uptimeS, appStartS, ffmpeg }) {
    const appUptimeS = uptimeS !== null && appStartS !== null ? Math.round(uptimeS - appStartS) : null;
    return {
      ...(this.static || {}),
      uptimeS: uptimeS === null ? null : Math.round(uptimeS),
      appUptimeS: appUptimeS !== null && appUptimeS >= 0 ? appUptimeS : null,
      ffmpeg
    };
  }
}

module.exports = { HostInfo, osFromKernel, appVersion, parseFfmpegVersion, probeFfmpeg };
