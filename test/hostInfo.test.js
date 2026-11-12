'use strict';

// The heartbeat's host field (server/hostInfo.js, docs/reports-api.md "The
// heartbeat"): the kind of host from the host's kernel string in a container,
// from os-release outside one, a Raspberry Pi from its device tree; whether
// it runs in a container; one word from the protocol's list, nothing else.

const test = require('node:test');
const assert = require('node:assert/strict');
const P = require('../server/reportsProtocol');
const { detectHost, inContainer, parseOsRelease, hostInfo } = require('../server/hostInfo');

// a fake fs: these files and nothing else
const fakeFs = (files) => ({
  existsSync: (p) => Object.hasOwn(files, p),
  readFileSync: (p) => {
    if (!Object.hasOwn(files, p)) throw Object.assign(new Error(`ENOENT ${p}`), { code: 'ENOENT' });
    return files[p];
  }
});
const fakeOs = (release) => ({ release: () => release });
const DOCKER = { '/.dockerenv': '' };
const PI_MODEL = 'Raspberry Pi 5 Model B Rev 1.0\u0000';
const detect = ({ release = '', files = {}, platform = 'linux', arch = 'x64' }) => detectHost({ fs: fakeFs(files), os: fakeOs(release), platform, arch });

test('in a container: the host from its kernel string', () => {
  const table = [
    ['6.6.44-production+truenas', 'x64', {}, 'truenas'],
    ['6.12.15-production+truenas', 'x64', {}, 'truenas'],
    ['6.1.106-Unraid', 'x64', {}, 'unraid'],
    ['6.12.24-Unraid', 'x64', {}, 'unraid'],
    ['5.15.153.1-microsoft-standard-WSL2', 'x64', {}, 'wsl'],
    ['6.6.87.2-microsoft-standard-WSL2', 'x64', {}, 'wsl'],
    ['4.19.128-microsoft-standard', 'x64', {}, 'wsl'],
    ['6.10.14-linuxkit', 'arm64', {}, 'macos'],
    ['6.10.14-linuxkit', 'x64', {}, 'wsl'],
    ['6.6.31+rpt-rpi-v8', 'arm64', {}, 'raspberry-pi'],
    ['6.6.31+rpt-rpi-2712', 'arm64', { '/proc/device-tree/model': PI_MODEL }, 'raspberry-pi'],
    ['5.15.0-1034-raspi', 'arm64', {}, 'raspberry-pi'],
    ['5.15.84-v8+', 'arm64', { '/sys/firmware/devicetree/base/model': 'Raspberry Pi 4 Model B Rev 1.4' }, 'raspberry-pi'],
    ['5.15.84-v8+', 'arm64', {}, 'linux'],
    ['4.4.302+', 'x64', { '/proc/version': 'Linux version 4.4.302+ (root@build6) (gcc version 12.2.0) #72806 SMP synology_geminilake_920+' }, 'synology'],
    ['4.4.302+', 'x64', { '/proc/sys/kernel/syno_hw_version': 'DS920+' }, 'synology'],
    ['5.10.60-qnap', 'x64', {}, 'qnap'],
    ['6.8.0-45-generic', 'x64', { '/etc/os-release': 'ID=debian\n' }, 'linux'],
    ['6.1.0-25-amd64', 'x64', {}, 'linux'],
    ['', 'x64', {}, 'linux']
  ];
  for (const [release, arch, files, want] of table) {
    assert.deepEqual(detect({ release, arch, files: { ...DOCKER, ...files } }), { os: want, docker: true }, `${release} (${arch})`);
  }
});

test('in a container: /proc/version when the release string says nothing', () => {
  assert.equal(detect({ release: '', files: { ...DOCKER, '/proc/version': 'Linux version 6.6.44-production+truenas (root@tnsbuilds01.tn.ixsystems.net)' } }).os, 'truenas');
  assert.equal(detect({ release: '', files: { ...DOCKER, '/proc/version': 'Linux version 5.15.153.1-microsoft-standard-WSL2 (root@941d701f84f1)' } }).os, 'wsl');
});

test('outside a container: os-release, the kernel signs and the device tree', () => {
  const rel = (id, like) => ({ '/etc/os-release': `NAME="X"\nID=${id}\n${like ? `ID_LIKE="${like}"\n` : ''}VERSION_ID="1"\n` });
  const table = [
    ['6.8.0-45-generic', rel('ubuntu', 'debian'), 'ubuntu'],
    ['6.1.0-25-amd64', rel('debian'), 'debian'],
    ['6.11.4-301.fc41.x86_64', rel('fedora'), 'fedora'],
    ['6.1.21-v8+', rel('raspbian', 'debian'), 'raspberry-pi'],
    // Raspberry Pi OS (bookworm) calls itself debian: the device tree tells
    ['6.6.31+rpt-rpi-v8', rel('debian'), 'raspberry-pi'],
    ['6.1.0-25-arm64', { ...rel('debian'), '/proc/device-tree/model': PI_MODEL }, 'raspberry-pi'],
    // TrueNAS SCALE calls itself debian too: its kernel tells
    ['6.6.44-production+truenas', rel('debian'), 'truenas'],
    ['6.6.44', rel('truenas'), 'truenas'],
    ['6.1.106-Unraid', {}, 'unraid'],
    ['6.1.106', rel('unraid'), 'unraid'],
    ['5.15.153.1-microsoft-standard-WSL2', rel('ubuntu', 'debian'), 'wsl'],
    ['6.8.0', rel('linuxmint', 'ubuntu debian'), 'ubuntu'],
    ['5.14.0', rel('rocky', 'rhel centos fedora'), 'fedora'],
    ['6.6.0', rel('arch'), 'linux'],
    ['6.6.0', rel('alpine'), 'linux'],
    ['6.6.0', {}, 'linux'],
    ['6.6.0', { '/usr/lib/os-release': 'ID="fedora"\n' }, 'fedora']
  ];
  for (const [release, files, want] of table) assert.deepEqual(detect({ release, files }), { os: want, docker: false }, `${release} ${JSON.stringify(files)}`);
  assert.deepEqual(detect({ release: '24.1.0', platform: 'darwin', arch: 'arm64' }), { os: 'macos', docker: false });
  assert.deepEqual(detect({ release: '10.0.26100', platform: 'win32' }), { os: null, docker: false });
});

test('a container: /.dockerenv, or docker, containerd, kubepods or libpod in /proc/1/cgroup or /proc/self/mountinfo', () => {
  assert.equal(inContainer({ fs: fakeFs({}) }), false);
  assert.equal(inContainer({ fs: fakeFs({ '/proc/1/cgroup': '0::/init.scope\n', '/proc/self/mountinfo': '22 1 8:1 / / rw - ext4 /dev/sda1 rw\n' }) }), false);
  assert.equal(inContainer({ fs: fakeFs({ '/.dockerenv': '' }) }), true);
  for (const line of ['12:pids:/docker/3f1c2a9e', '0::/system.slice/containerd.service', '11:cpu:/kubepods/besteffort/pod1234', '0::/machine.slice/libpod-abc.scope']) {
    assert.equal(inContainer({ fs: fakeFs({ '/proc/1/cgroup': line }) }), true, line);
  }
  assert.equal(inContainer({ fs: fakeFs({ '/proc/self/mountinfo': '641 512 0:52 / / rw - overlay overlay rw,lowerdir=/var/lib/docker/overlay2/l/ABC' }) }), true);
  // an unreadable file is no container
  assert.equal(inContainer({ fs: { existsSync: () => { throw new Error('EACCES'); }, readFileSync: () => { throw new Error('EACCES'); } } }), false);
});

test('only a word from the list leaves: never the kernel string or anything else', () => {
  const r = detect({ release: '6.6.44-production+truenas', files: { ...DOCKER, '/proc/version': 'Linux version 6.6.44 (root@tower.example.lan)' } });
  assert.deepEqual(Object.keys(r), ['os', 'docker']);
  assert.ok(P.HEARTBEAT_HOST_OS.includes(r.os));
  assert.doesNotMatch(JSON.stringify(r), /6\.6|tower|example/);
  assert.deepEqual(parseOsRelease('NAME="Ubuntu"\nID=ubuntu\nID_LIKE=debian\n# a comment\nPRETTY_NAME=\'Ubuntu 24.04\'\n'), { NAME: 'Ubuntu', ID: 'ubuntu', ID_LIKE: 'debian', PRETTY_NAME: 'Ubuntu 24.04' });
});

test('hostInfo: this machine, worked out once, and right for the protocol', () => {
  const a = hostInfo();
  assert.deepEqual(Object.keys(a), ['os', 'docker']);
  assert.ok(a.os === null || P.HEARTBEAT_HOST_OS.includes(a.os));
  assert.equal(typeof a.docker, 'boolean');
  a.os = 'changed';
  assert.notEqual(hostInfo().os, 'changed', 'a copy each time');
  assert.deepEqual(hostInfo(), detectHost());
});
