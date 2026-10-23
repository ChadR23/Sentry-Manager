'use strict';

// Network traffic from /proc/net/dev: the container's own interfaces, or the
// whole server's when the container runs with `pid: host` (then pid 1 is the
// host's init and /proc/1/net/dev shows the host's interfaces). The same
// counters feed the data used per day (traffic.js).

const { readText, readLine, readNum, readLink, exists, join } = require('./util');

// loopback, container and VM plumbing and other virtual links: their
// traffic is already counted on the real interface
const SKIP = /^(lo|veth|docker\d|br-[0-9a-f]{6,}|podman|virbr|lxcbr|lxdbr|incusbr|cni|flannel|cali|cilium|weave|vnet|tap\d|fwbr|fwpr|fwln|ifb|dummy|kube|vxlan|genev|tunl|sit\d|ip6tnl|gre)/;
// bridge > bond > port, for when sysfs cannot say which port belongs to what
const LAYER = (n) => (/^(br|vmbr)\d/.test(n) ? 3 : /^(bond|team)\d/.test(n) ? 2 : /^(eth|en|em|wl)/.test(n) ? 1 : 0);

function parseNetDev(text) {
  const out = new Map();
  for (const line of String(text || '').split('\n')) {
    const i = line.indexOf(':');
    if (i < 0) continue;
    const name = line.slice(0, i).trim();
    const f = line.slice(i + 1).trim().split(/\s+/).map(Number);
    if (!name || f.length < 9 || !Number.isFinite(f[0]) || !Number.isFinite(f[8])) continue;
    out.set(name, { rx: f[0], tx: f[8] });
  }
  return out;
}

class NetworkProvider {
  constructor({ procRoot, sysRoot, now }) {
    this.procRoot = procRoot;
    this.sysRoot = sysRoot;
    this.now = now;
    this.scope = 'container';
    this.prev = null;
    this.prevAt = null;
    this.speeds = new Map();
    this.counters = null; // the last reading's counted interfaces: name -> { rx, tx, speedMbps }
    this.readAt = null;
    this.ownNetns = true;
    this.boot = null;
    this.netns = null;
  }

  probe() {
    const own = parseNetDev(readText(join(this.procRoot, 'net', 'dev')));
    const init = parseNetDev(readText(join(this.procRoot, '1', 'net', 'dev')));
    const names = (m) => [...m.keys()].sort().join(',');
    this.scope = init.size && names(init) !== names(own) ? 'host' : 'container';
    // the same links as our own: the app's network namespace (and its sysfs)
    this.ownNetns = this.scope === 'container';
    // with network_mode: host the container already sees the host's links
    if (this.scope === 'container' && [...own.keys()].some((n) => /^(docker0|veth)/.test(n))) this.scope = 'host';
    this.file = this.scope === 'host' && init.size ? join(this.procRoot, '1', 'net', 'dev') : join(this.procRoot, 'net', 'dev');
    this.prev = null;
    // which counters these are, so a restart of the app alone can count on
    // from the saved readings; the host's links (pid: host) are in a
    // namespace the app cannot name, and there a restart starts a new count
    this.boot = readLine(join(this.procRoot, 'sys', 'kernel', 'random', 'boot_id'));
    this.netns = this.ownNetns ? readLink(join(this.procRoot, 'self', 'ns', 'net')) : null;
  }

  /** What the counters belong to: { scope, boot, netns }, null where unknown. */
  where() {
    return { scope: this.scope, boot: this.boot, netns: this.netns };
  }

  /** An interface's index (sysfs shows only our own namespace's links), or null. */
  ifindex(name) {
    if (!this.ownNetns) return null;
    const v = readNum(join(this.sysRoot, 'class', 'net', name, 'ifindex'));
    return Number.isInteger(v) && v > 0 ? v : null;
  }

  /** Link speed in Mbit/s; virtual links (a container's veth) report a made-up 10000. */
  speed(name) {
    const dir = join(this.sysRoot, 'class', 'net', name);
    if (!exists(join(dir, 'device'))) return null;
    const v = readNum(join(dir, 'speed'));
    return v !== null && v > 0 && v < 10000000 ? v : null;
  }

  /**
   * A port in a bridge or bond carries the same bytes as its master (Unraid:
   * eth0 in bond0 in br0), so only the top one counts. sysfs says which is
   * enslaved; for the host's links seen through pid: host it cannot, and
   * then only the top layer present is kept.
   */
  topLevel(names) {
    const dir = join(this.sysRoot, 'class', 'net');
    if (names.every((n) => exists(join(dir, n)))) return names.filter((n) => !exists(join(dir, n, 'master')));
    const top = Math.max(0, ...names.map(LAYER));
    return names.filter((n) => LAYER(n) === 0 || LAYER(n) === top);
  }

  sample() {
    const t = this.now();
    this.counters = null;
    const cur = parseNetDev(readText(this.file));
    const dt = this.prevAt === null ? 0 : (t - this.prevAt) / 1000;
    const interfaces = [];
    const keep = new Set(this.topLevel([...cur.keys()].filter((n) => !SKIP.test(n))));
    const counters = new Map();
    for (const [name, c] of cur) {
      if (!keep.has(name)) continue;
      const before = this.prev?.get(name);
      const ok = before && dt > 0 && c.rx >= before.rx && c.tx >= before.tx;
      const speedMbps = this.speedCache(name);
      interfaces.push({
        name,
        speedMbps,
        rxBps: ok ? Math.round((c.rx - before.rx) / dt) : null,
        txBps: ok ? Math.round((c.tx - before.tx) / dt) : null
      });
      counters.set(name, { rx: c.rx, tx: c.tx, speedMbps });
    }
    if (cur.size) {
      this.prev = cur;
      this.prevAt = t;
      this.counters = counters;
      this.readAt = t;
    }
    return { scope: this.scope, interfaces };
  }

  // the speed only changes when a cable is replugged; ask once a minute
  speedCache(name) {
    const t = this.now();
    const hit = this.speeds.get(name);
    if (hit && t - hit.at < 60000) return hit.value;
    const value = this.speed(name);
    if (this.speeds.size > 256) this.speeds.clear();
    this.speeds.set(name, { value, at: t });
    return value;
  }
}

module.exports = { NetworkProvider, parseNetDev };
