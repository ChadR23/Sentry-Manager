'use strict';

// Data used, in bytes received and sent, per day (in the server's time zone,
// the same days as energy.js), from the cumulative byte counters of the
// interfaces the Network tile counts. A counter keeps counting while nobody
// watches, so a gap between readings loses nothing; its bytes are split over
// the days it spans in proportion to time. That split is a guess, so the app
// also reads the counters once a day, in the minute after midnight
// (stats.tick()): each day then holds its own bytes, and only a gap over a
// midnight the app was not running for is split.
// A counter that went down (the interface was made again, the container or
// the server restarted, an old driver's 32-bit counter wrapped) only starts
// a new count, and a jump faster than any link is dropped, so a bogus number
// never lands in a day. The speed a link reports is no limit (an emulated
// NIC in a virtual machine says 1 Gbit/s and carries more), and a long gap
// may hold any amount a link could carry in that time.
//
// The days are kept per scope (this container, or the whole server with
// pid: host) and the scope read last is the one shown, so the bytes of one
// are never shown as the other's.
//
// The last readings are saved with the days. After a restart of the app
// alone (same boot, same network namespace, same interface index) the first
// reading counts on from the saved one, so the restart loses nothing; any
// other first reading only starts the count.

const { dayKey } = require('./energy');

const DAYS_KEPT = 62;
const MAX_BPS = 50e9; // bytes per second: no link carries more than 400 Gbit/s
const SLACK = 1.1; // the readings are a few ms off the clock's times
const SLACK_B = 1048576;
const MAX_IFACES = 256;
const IFNAME = /^[^\s/:]{1,15}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const SCOPES = ['container', 'host'];

const finite = (n) => typeof n === 'number' && Number.isFinite(n) && n >= 0;
const text = (s) => (typeof s === 'string' && s.length > 0 && s.length <= 128 ? s : null);
const scopeOf = (s) => (s === 'host' ? 'host' : 'container');
const sameWhere = (a, b) => Boolean(a && b) && a.scope === b.scope && a.boot === b.boot && a.netns === b.netns;
// no prototype: the keys are dates, but nothing from a file reaches Object.prototype
const noDays = () => ({ container: Object.create(null), host: Object.create(null) });

function indexOf(ifindexOf, name) {
  try {
    const v = ifindexOf(name);
    return Number.isInteger(v) && v > 0 ? v : null;
  } catch {
    return null;
  }
}

class Traffic {
  constructor() {
    this.scopes = noDays(); // scope -> 'YYYY-MM-DD' -> { rx, tx } bytes
    this.scope = 'container'; // the scope read last: its days are the ones shown
    this.last = new Map(); // interface -> { rx, tx, t, ifindex }
    this.where = null; // { scope, boot, netns } of the readings in `last`
    this.saved = null; // { where, ifaces } from before a restart, until the first reading
  }

  /** The days of the scope read last. */
  get days() {
    return this.scopes[this.scope];
  }

  /**
   * One reading at t: the counted interfaces' counters (a Map of name ->
   * { rx, tx }), or null when nothing could be read (then nothing changes).
   * `where` is what was read: { scope, boot, netns }, null where unknown;
   * ifindexOf(name) answers the interface's index, or null.
   */
  add(t, counters, where = {}, ifindexOf = () => null) {
    if (!(counters instanceof Map) || !Number.isFinite(t)) return;
    const here = { scope: text(where?.scope), boot: text(where?.boot), netns: text(where?.netns) };
    if (!sameWhere(this.where, here)) this.last = new Map();
    this.where = here;
    this.scope = scopeOf(here.scope);
    // the saved readings stand in for the previous ones once, and only where
    // the very same counters must have kept counting
    const saved = this.saved && here.boot && here.netns && sameWhere(this.saved.where, here) ? this.saved.ifaces : null;
    this.saved = null;
    const next = new Map();
    for (const [name, c] of counters) {
      if (next.size >= MAX_IFACES || !c || !finite(c.rx) || !finite(c.tx)) continue;
      let prev = this.last.get(name) || null;
      const ifindex = prev ? prev.ifindex : indexOf(ifindexOf, name);
      if (!prev && saved && ifindex !== null && saved.get(name)?.ifindex === ifindex) prev = saved.get(name);
      const cur = { rx: c.rx, tx: c.tx, t, ifindex };
      // a new count: the link under this name may be a new one
      if (prev && !this.count(prev, cur)) cur.ifindex = indexOf(ifindexOf, name);
      next.set(name, cur);
    }
    this.last = next;
  }

  /** The bytes from prev to cur, when they can be real; false means "start a new count". */
  count(prev, cur) {
    const ms = cur.t - prev.t;
    const rx = cur.rx - prev.rx;
    const tx = cur.tx - prev.tx;
    if (!(ms > 0) || !(rx >= 0) || !(tx >= 0)) return false;
    const most = MAX_BPS * (ms / 1000) * SLACK + SLACK_B;
    if (rx > most || tx > most) return false;
    this.spread(prev.t, cur.t, rx, tx);
    return true;
  }

  /**
   * rx and tx bytes moved between from and to, split over the days in
   * proportion to time (counted by date: a 23- or 25-hour day around a clock
   * change is still one day). Days older than the kept ones are skipped.
   */
  spread(from, to, rx, tx) {
    const ms = to - from;
    const end = new Date(to);
    let at = Math.max(from, new Date(end.getFullYear(), end.getMonth(), end.getDate() - (DAYS_KEPT - 1)).getTime());
    // what is handed out is rounded on the running total, so the days add up to the whole
    let doneRx = Math.round(rx * ((at - from) / ms));
    let doneTx = Math.round(tx * ((at - from) / ms));
    const days = this.days;
    while (at < to) {
      const d = new Date(at);
      const until = Math.min(to, new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).getTime());
      const upRx = until === to ? rx : Math.round(rx * ((until - from) / ms));
      const upTx = until === to ? tx : Math.round(tx * ((until - from) / ms));
      const key = dayKey(at);
      const day = days[key] || (days[key] = { rx: 0, tx: 0 });
      day.rx += upRx - doneRx;
      day.tx += upTx - doneTx;
      doneRx = upRx;
      doneTx = upTx;
      at = until;
    }
  }

  /**
   * { today, week, month } of the scope read last: { rxB, txB } each, or
   * null when no time in it was measured. The week is the 7 calendar days
   * ending today, the month the current calendar month.
   */
  summary(t) {
    const today = dayKey(t);
    const d = new Date(t);
    const week = [];
    for (let i = 0; i < 7; i++) week.push(dayKey(new Date(d.getFullYear(), d.getMonth(), d.getDate() - i, 12).getTime()));
    const month = Object.keys(this.days).filter((k) => k.slice(0, 7) === today.slice(0, 7) && k <= today);
    return { today: this.total([today]), week: this.total(week), month: this.total(month) };
  }

  total(keys) {
    let rx = 0;
    let tx = 0;
    let measured = false;
    for (const k of keys) {
      const v = this.days[k];
      if (!v) continue;
      measured = true;
      rx += v.rx;
      tx += v.tx;
    }
    return measured ? { rxB: Math.round(rx), txB: Math.round(tx) } : null;
  }

  trim() {
    for (const days of Object.values(this.scopes)) {
      const keys = Object.keys(days).sort();
      for (const k of keys.slice(0, Math.max(0, keys.length - DAYS_KEPT))) delete days[k];
    }
  }

  toJSON() {
    this.trim();
    // readings not used yet (no reading since the start) are kept as they came
    const src = this.saved || { where: this.where, ifaces: this.last };
    const w = src.where;
    const ifaces = [...src.ifaces].filter(([, c]) => c.ifindex !== null).map(([name, c]) => [name, { rx: c.rx, tx: c.tx, t: c.t, ifindex: c.ifindex }]);
    // only readings a restart can check are worth keeping
    const last = w && w.boot && w.netns && ifaces.length ? { scope: w.scope, boot: w.boot, netns: w.netns, ifaces: Object.fromEntries(ifaces) } : null;
    return { scope: this.scope, days: this.scopes, last };
  }

  load(data) {
    if (!data || typeof data !== 'object') return;
    const scopes = noDays();
    const src = data.days && typeof data.days === 'object' ? data.days : {};
    for (const scope of SCOPES) {
      const days = Object.hasOwn(src, scope) && src[scope] && typeof src[scope] === 'object' ? src[scope] : {};
      for (const [k, v] of Object.entries(days)) if (DATE.test(k) && v && finite(v.rx) && finite(v.tx)) scopes[scope][k] = { rx: v.rx, tx: v.tx };
    }
    this.scopes = scopes;
    this.scope = scopeOf(data.scope);
    this.trim();
    this.saved = null;
    const l = data.last;
    if (!l || typeof l !== 'object' || !text(l.boot) || !text(l.netns) || !l.ifaces || typeof l.ifaces !== 'object') return;
    const ifaces = new Map();
    for (const [name, c] of Object.entries(l.ifaces)) {
      if (ifaces.size >= MAX_IFACES) break;
      if (IFNAME.test(name) && c && finite(c.rx) && finite(c.tx) && Number.isFinite(c.t) && Number.isInteger(c.ifindex) && c.ifindex > 0) {
        ifaces.set(name, { rx: c.rx, tx: c.tx, t: c.t, ifindex: c.ifindex });
      }
    }
    this.saved = { where: { scope: text(l.scope), boot: l.boot, netns: l.netns }, ifaces };
  }
}

module.exports = { Traffic, DAYS_KEPT, MAX_BPS };
