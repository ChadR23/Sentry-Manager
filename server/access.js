'use strict';

// Settings → Security, for a server open to the internet: bans after
// repeated failed sign-ins, the two-step sign-in rules, and what an admin
// may do from outside the home network.
//
// Bans: every failed attempt (a wrong password, a wrong two-step code, a
// wrong password confirmation or current password, a wrong setup code)
// counts against the address it came from (an IPv6 address by its /64).
// maxFailures within windowMinutes (default 10 in 60: the sign-in slow-down
// lets an address reach 10 only after about 15 minutes) bans the address for banMinutes; each
// ban within a week of the last one doubles, up to maxBanHours. A banned
// address gets 429 on every sign-in step; a session already signed in
// keeps working (it needed the password), except that a session whose own
// password confirmations got its address banned is signed out. Bans are
// kept in the database (at most MAX_BANS, the oldest dropped first), so a
// restart does not lift them. Home-network addresses are never banned while
// exemptHome is on (the default), so the owner cannot lock themselves out at
// home. The sign-in slow-down (auth.js) stays as it was, in front of this.

const { parseCidr, banKey, homeMatcher } = require('./clientAddress');

const KEY_SETTINGS = 'security:access';
const KEY_BANS = 'security:bans';
const MAX_BANS = 2000;
const MAX_TRACKED = 10000;
const REPEAT_MS = 7 * 24 * 3600 * 1000; // a ban within a week of the last one counts as a repeat
const MAX_EXTRA = 32;

const DEFAULTS = Object.freeze({
  bans: Object.freeze({ enabled: true, maxFailures: 10, windowMinutes: 60, banMinutes: 60, maxBanHours: 24, exemptHome: true }),
  twoFactor: Object.freeze({ outside: false, everyone: false }),
  homeOnly: Object.freeze({ adminChanges: false, adminPages: false }),
  home: Object.freeze({ tailscale: false, extra: Object.freeze([]) })
});

const LIMITS = {
  maxFailures: [3, 100, 'Failed attempts before a ban'],
  windowMinutes: [1, 1440, 'The window for failed attempts (minutes)'],
  banMinutes: [1, 10080, 'The first ban (minutes)'],
  maxBanHours: [1, 720, 'The longest ban (hours)']
};

const bad = (msg) => Object.assign(new Error(msg), { status: 400 });

function clone(x) {
  return JSON.parse(JSON.stringify(x));
}

/** Stored or sent settings, filled with the defaults (nothing invalid is kept). */
function withDefaults(stored) {
  const s = stored && typeof stored === 'object' ? stored : {};
  const out = clone(DEFAULTS);
  for (const k of Object.keys(out)) if (s[k] && typeof s[k] === 'object') Object.assign(out[k], s[k]);
  out.home.extra = Array.isArray(out.home.extra) ? out.home.extra.filter((e) => parseCidr(e)) : [];
  return out;
}

/**
 * Settings as an admin sent them (a part is enough: the rest stays), checked;
 * throws a 400 that says what is wrong.
 */
function validate(input, current = DEFAULTS) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw bad('Send the settings as an object.');
  const out = withDefaults(current);
  const known = { bans: Object.keys(DEFAULTS.bans), twoFactor: Object.keys(DEFAULTS.twoFactor), homeOnly: Object.keys(DEFAULTS.homeOnly), home: Object.keys(DEFAULTS.home) };
  for (const [part, value] of Object.entries(input)) {
    if (!known[part]) throw bad(`Unknown setting "${part}".`);
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw bad(`"${part}" must be an object.`);
    for (const [k, v] of Object.entries(value)) {
      if (!known[part].includes(k)) throw bad(`Unknown setting "${part}.${k}".`);
      if (part === 'home' && k === 'extra') {
        out.home.extra = parseExtra(v);
      } else if (LIMITS[k]) {
        const [min, max, label] = LIMITS[k];
        const n = Number(v);
        if (!Number.isInteger(n) || n < min || n > max) throw bad(`${label}: a whole number from ${min} to ${max}.`);
        out[part][k] = n;
      } else {
        if (typeof v !== 'boolean') throw bad(`"${part}.${k}" is on or off (true or false).`);
        out[part][k] = v;
      }
    }
  }
  if (out.bans.maxBanHours * 60 < out.bans.banMinutes) throw bad('The longest ban cannot be shorter than the first ban.');
  return out;
}

/** The extra home ranges: a list or a text of addresses and ranges. */
function parseExtra(v) {
  const items = Array.isArray(v) ? v : String(v ?? '').split(/[\s,]+/);
  const out = [];
  for (const raw of items.map((x) => String(x).trim()).filter(Boolean)) {
    const c = parseCidr(raw);
    if (!c) throw bad(`"${raw.slice(0, 60)}" is not an address or a range like 192.0.2.0/24.`);
    if ((c.family === 'ipv4' && c.prefix < 8) || (c.family === 'ipv6' && c.prefix < 32)) {
      throw bad(`${c.text} is too wide to be a home network (at most /8 for IPv4, /32 for IPv6).`);
    }
    if (!out.includes(c.text)) out.push(c.text);
  }
  if (out.length > MAX_EXTRA) throw bad(`At most ${MAX_EXTRA} extra ranges.`);
  return out;
}

/**
 * The settings and the bans, kept in the database.
 * audit: a logger (warn/info) for every ban and unban.
 */
function createAccess({ db, audit = null, now = () => Date.now() }) {
  let settings = withDefaults(db.get(KEY_SETTINGS, null));
  let isHomeFn = homeMatcher(settings.home);
  const failures = new Map(); // ban key -> [timestamps]
  const bans = new Map(); // ban key -> { key, at, until, reason, failures, offences }
  for (const b of db.get(KEY_BANS, []) || []) {
    if (b && typeof b.key === 'string' && Number.isFinite(b.until)) bans.set(b.key, b);
  }

  const save = () => {
    // what is still in force first, then what is remembered for repeats
    const t = now();
    for (const [k, b] of bans) if (b.until + REPEAT_MS < t) bans.delete(k);
    if (bans.size > MAX_BANS) {
      const order = [...bans.values()].sort((a, b) => a.until - b.until);
      for (const b of order.slice(0, bans.size - MAX_BANS)) bans.delete(b.key);
    }
    db.set(KEY_BANS, [...bans.values()]);
  };

  const get = () => clone(settings);
  function set(next) {
    settings = withDefaults(next);
    isHomeFn = homeMatcher(settings.home);
    db.set(KEY_SETTINGS, settings);
    return get();
  }
  const isHome = (ip) => isHomeFn(ip);

  /** The ban in force for this address, or null. */
  function banned(ip) {
    const b = bans.get(banKey(ip));
    if (!b || b.until <= now()) return null;
    // a home address is never held back while home addresses are exempt
    if (settings.bans.exemptHome && isHome(ip)) return null;
    return { ...b };
  }

  /**
   * One failed attempt from this address; the ban, when it was the one too
   * many (else null).
   */
  function fail(ip, reason) {
    const cfg = settings.bans;
    if (!cfg.enabled) return null;
    if (cfg.exemptHome && isHome(ip)) return null;
    const key = banKey(ip);
    const t = now();
    const since = t - cfg.windowMinutes * 60_000;
    const list = (failures.get(key) || []).filter((x) => x > since);
    list.push(t);
    failures.delete(key);
    failures.set(key, list.slice(-200));
    if (failures.size > MAX_TRACKED) failures.delete(failures.keys().next().value);
    if (list.length < cfg.maxFailures) return null;
    return ban(key, reason, list.length);
  }

  function ban(key, reason, count) {
    const cfg = settings.bans;
    const t = now();
    const prev = bans.get(key);
    const offences = prev && prev.until + REPEAT_MS > t ? (prev.offences || 1) + 1 : 1;
    const minutes = Math.min(cfg.banMinutes * 2 ** (offences - 1), cfg.maxBanHours * 60);
    const b = { key, at: t, until: t + minutes * 60_000, reason: String(reason || 'failed attempts').slice(0, 120), failures: count, offences };
    bans.delete(key);
    bans.set(key, b);
    failures.delete(key);
    save();
    audit?.warn(`Banned ${key} for ${minutes >= 60 && minutes % 60 === 0 ? `${minutes / 60} h` : `${minutes} min`} (until ${new Date(b.until).toISOString()}) after ${count} failed attempts in ${cfg.windowMinutes} min (last: ${b.reason})${offences > 1 ? `, ban number ${offences} this week` : ''}`);
    return { ...b };
  }

  /** Lift a ban (and forget its history and failures). */
  function unban(key, who) {
    const k = String(key || '').trim();
    const hit = bans.get(k) || bans.get(banKey(k));
    if (!hit) throw Object.assign(new Error('That address is not banned.'), { status: 404 });
    bans.delete(hit.key);
    failures.delete(hit.key);
    save();
    audit?.warn(`Unbanned ${hit.key}${who ? `: ${who}` : ''}`);
    return { ok: true };
  }

  /** The bans in force, newest first. */
  function list() {
    const t = now();
    return [...bans.values()].filter((b) => b.until > t).sort((a, b) => b.at - a.at).map((b) => ({ ...b }));
  }

  /** Failed attempts counted now (for the settings page). */
  const watching = () => {
    const since = now() - settings.bans.windowMinutes * 60_000;
    let n = 0;
    for (const l of failures.values()) if (l.some((x) => x > since)) n++;
    return n;
  };

  return { get, set, isHome, banned, fail, unban, list, watching };
}

module.exports = { createAccess, validate, withDefaults, DEFAULTS, LIMITS };
