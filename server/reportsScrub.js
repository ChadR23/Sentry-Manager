'use strict';

// Cleaning a report before it is sealed (server/reports.js).
//
// stripSecrets: ALWAYS. Values under secret-sounding names (password,
// token, key, secret, cookie, webhook, credential, link key, recovery, ...)
// become "[removed]", and secrets written inside text are cut out: PEM
// blocks (TLS and other private keys), user:password@ in URLs, Discord and
// other webhook URLs, Bearer/Basic headers, password=/token=/key= pairs,
// session cookies, JWTs and GitHub tokens.
//
// anonymize: when "Send anonymously" is on. Every identifier becomes
// "ANON": the identifiers the server knows (install id, host name, vehicle
// names and ids, account names, share hosts, paths and user names, Sentry USB
// names and addresses, Wi-Fi SSIDs, place names, its own host names) wherever
// they appear, values under identifying names (hostname, ip, mac, ssid, vin,
// email, user, lat/lon, city, path, share, ...), and by pattern in every
// string, log lines and stack traces included: IPv4 and IPv6 addresses, MAC
// addresses, e-mail addresses, Tesla VINs, GPS coordinates, local host
// names, \\host\share and //host/share, and the host of any URL that is not
// a well-known public one.

const net = require('net');

const ANON = 'ANON';
const REMOVED = '[removed]';
const norm = (k) => String(k).toLowerCase().replace(/[-_ .]/g, '');

const SECRET_KEY = /(password|passwd|passphrase|^pwd$|^pass$|secret|token|apikey|privatekey|cookie|credential|authorization|^auth$|authheader|webhook|linkkey|recovery|totp|^otp|^psk$|sessionid|^session$|^sessions$|signature|^sig$|key$|keys$|^salt$|^setupcode$|pairingcode)/;
/** Whether a field's name says its value is a secret. */
const isSecretKey = (k) => SECRET_KEY.test(norm(k));

const ID_KEY = /^(hostname|hostnames|host|hosts|ssid|ssids|wifi|address|addresses|ip|ips|ipaddress|mac|macaddress|vin|vins|email|emails|user|username|usernames|users|account|accounts|owner|by|lat|lon|lng|latitude|longitude|coords|coordinates|gps|city|place|places|placename|street|location|gw|gateway|domain|domains|share|sharepath|path|paths|root|roots|folder|installid|install|vehiclename|devicename|nodename|home|homenetwork|peer|remote|remoteaddress|client|clientaddress|from|tlshostnames|acmedomain)$/;
/** Whether a field's name says its value identifies someone or something (anonymous reports). */
const isIdKey = (k) => ID_KEY.test(norm(k));

// ---- secrets inside text
const SECRET_TEXT = [
  [/-----BEGIN [A-Z0-9 ]+-----[\s\S]*?(?:-----END [A-Z0-9 ]+-----|$)/g, REMOVED],
  [/\bhttps?:\/\/(?:[\w.-]+\.)?(?:discord(?:app)?\.com|discord\.gg)\/api\/webhooks\/[^\s"'<>]*/gi, REMOVED],
  [/\bhttps?:\/\/hooks\.slack\.com\/[^\s"'<>]*/gi, REMOVED],
  [/\bhttps?:\/\/[^\s"'<>]*\/(?:api\/)?webhooks?\/[^\s"'<>]*/gi, REMOVED],
  [/(\b[a-z][a-z0-9+.-]*:\/\/)[^\s/@:"']+:[^\s/@"']+@/gi, `$1${REMOVED}@`],
  [/\b(Bearer|Basic|Token)\s+[A-Za-z0-9._~+/=-]{8,}/g, `$1 ${REMOVED}`],
  [/\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]*/g, REMOVED],
  [/\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g, REMOVED],
  // name=value, name: value, and JSON's "name": value (a settings object in an
  // error message or a log line); pass= is a cifs mount option
  [/\b([A-Za-z_]*(?:password|passwd|pwd|passphrase|pass|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|link[_-]?key|psk|cookie|session|sid|auth)[A-Za-z_]*)(["']?\s*[=:]\s*)("[^"]*"|'[^']*'|[^\s,;&)}\]]+)/gi, `$1$2${REMOVED}`]
];
function stripSecretText(text) {
  let t = String(text);
  for (const [re, to] of SECRET_TEXT) t = t.replace(re, to);
  return t;
}

/** A copy of value with every secret removed (by field name and inside text). */
function stripSecrets(value) {
  const walk = (v, depth) => {
    if (depth > 40) return null;
    if (typeof v === 'string') return stripSecretText(v);
    if (Array.isArray(v)) return v.map((x) => walk(x, depth + 1));
    if (v && typeof v === 'object') {
      const out = {};
      for (const [k, x] of Object.entries(v)) {
        if (isSecretKey(k)) {
          // a yes/no or a count under such a name tells nothing secret (passwordSet: true)
          out[k] = typeof x === 'boolean' || x === null || x === undefined ? x : REMOVED;
        } else out[k] = walk(x, depth + 1);
      }
      return out;
    }
    return v;
  };
  return walk(value, 0);
}

// ---- identifiers inside text
const PUBLIC_HOSTS = /(^|\.)(github\.com|githubusercontent\.com|ghcr\.io|skittles\.live|cloudflare\.com|letsencrypt\.org|nodejs\.org|npmjs\.org|ffmpeg\.org|tesla\.com|openstreetmap\.org|discord\.com|google\.com|docker\.com|docker\.io|example\.com|example\.org)$/i;
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const TESLA_VIN = /\b(?:5YJ|7SA|LRW|XP7|7G2|SFZ|5YJ|7FC)[A-HJ-NPR-Z0-9]{14}\b/gi;
const EMAIL = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}\b/g;
const MAC = /\b[0-9A-Fa-f]{2}(?:([:-])[0-9A-Fa-f]{2})(?:\1[0-9A-Fa-f]{2}){4}\b/g;
const IPV4 = /\b(?:25[0-5]|2[0-4]\d|1?\d?\d)(?:\.(?:25[0-5]|2[0-4]\d|1?\d?\d)){3}\b/g;
// (after a colon only when that colon follows a word, as in ip:2001:db8::1)
const IPV6_CANDIDATE = /(?<![0-9A-Za-z])(?<![0-9A-Fa-f:]:)\[?((?:[0-9A-Fa-f]{0,4}:){2,7}[0-9A-Fa-f]{0,4}(?:\.\d{1,3}){0,3}(?:%[A-Za-z0-9_.-]+)?)\]?(?![0-9A-Za-z:])/g;
const COORD_PAIR = /-?\b\d{1,3}\.\d{3,}\s*,\s*-?\d{1,3}\.\d{3,}\b/g;
const COORD_NAMED = /\b(lat|lon|lng|latitude|longitude)(["']?\s*[:=]\s*)-?\d{1,3}(?:\.\d+)?/gi;
const LOCAL_HOST = /\b(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+(?:local|lan|home|home\.arpa|internal|localdomain|ts\.net|fritz\.box)\b/gi;
const UNC = /(?<![A-Za-z0-9+.-]:)(?:\/\/|\\\\)[A-Za-z0-9._-]+(?:[/\\][^\s"'<>,;)]*)?/g;
const URL_HOST = /\b([a-z][a-z0-9+.-]*:\/\/)(\[[0-9a-f:.]+\]|[A-Za-z0-9.-]+)/gi;

/**
 * The text-level anonymizer for a set of known identifiers (strings; the
 * longest replaced first, case-insensitively, as whole words or path parts).
 */
function makeAnonymizer(identifiers = []) {
  const known = [...new Set(identifiers.map((s) => String(s ?? '').trim()).filter((s) => s.length >= 3 && s !== ANON))].sort((a, b) => b.length - a.length);
  const knownRe = known.length ? new RegExp(`(?<![A-Za-z0-9])(?:${known.map(escapeRe).join('|')})(?![A-Za-z0-9])`, 'gi') : null;
  return function anonText(text) {
    let t = String(text);
    if (knownRe) t = t.replace(knownRe, ANON);
    t = t.replace(URL_HOST, (m, scheme, host) => (PUBLIC_HOSTS.test(host) || host === ANON ? m : `${scheme}${ANON}`));
    t = t.replace(UNC, ANON);
    t = t.replace(EMAIL, ANON);
    t = t.replace(TESLA_VIN, ANON);
    t = t.replace(MAC, ANON);
    t = t.replace(IPV6_CANDIDATE, (m, inner) => {
      const bare = inner.replace(/%.*$/, '');
      return net.isIPv6(bare) ? ANON : m;
    });
    t = t.replace(IPV4, ANON);
    t = t.replace(COORD_NAMED, `$1$2${ANON}`);
    t = t.replace(COORD_PAIR, ANON);
    t = t.replace(LOCAL_HOST, ANON);
    return t;
  };
}

/** A copy of value with every identifier replaced by "ANON" (keys too: a vehicle id used as a key becomes ANON-1, ANON-2, ...). */
function anonymize(value, { identifiers = [] } = {}) {
  const anonText = makeAnonymizer(identifiers);
  const walk = (v, depth) => {
    if (depth > 40) return null;
    if (typeof v === 'string') return anonText(v);
    if (Array.isArray(v)) return v.map((x) => walk(x, depth + 1));
    if (v && typeof v === 'object') {
      const out = {};
      let n = 0;
      for (const [k, x] of Object.entries(v)) {
        let key = anonText(k);
        if (key !== k) key = `${ANON}-${++n}`;
        if (isIdKey(k) && x !== null && x !== undefined && typeof x !== 'boolean') out[key] = ANON;
        else out[key] = walk(x, depth + 1);
      }
      return out;
    }
    return v;
  };
  return walk(value, 0);
}

/** What a report's contents go through before sealing: secrets out always; identifiers too when anonymous. */
function cleanReport(value, { anonymous = false, identifiers = [] } = {}) {
  const clean = stripSecrets(value);
  return anonymous ? anonymize(clean, { identifiers }) : clean;
}

module.exports = { ANON, REMOVED, isSecretKey, isIdKey, stripSecretText, stripSecrets, makeAnonymizer, anonymize, cleanReport };
