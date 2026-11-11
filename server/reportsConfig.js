'use strict';

// Where feedback and diagnostics reports go, and the key they are sealed to.
// THE ONE PLACE TO CHANGE THEM (docs/reports-api.md, "Changing the domain"
// and "Rotating the key").
//
// Nothing is ever sent unless someone turns "Share diagnostics with the
// developers" on, or presses Send for one feedback message or one support
// report (Settings → Help & feedback). Reports go only to the developers'
// private receiver, never to a third party.
//
// RECEIVER_KEYS: the receiver's public keys, newest first. Reports are sealed
// to the first; the others stay listed while a key is being replaced, and
// any of their signing keys may sign a "moved to" notice. Each entry is the
// receiver's key line as the developers publish it:
//   { kid: '<16 hex>', publicKey: '<base64 X25519, 32 bytes>', signingKey: '<base64 Ed25519, 32 bytes>' }
// While the list is empty, reporting is off in this build: Settings says
// "Reporting isn't set up in this build" and nothing is ever sent.
//
// Overrides without a new build (environment):
//   REPORTS=off         no reporting on this server at all (Help & feedback says it is off)
//   REPORTS_URL         another receiver (https:// only; http://localhost only in tests)
//   REPORTS_PUBLIC_KEY  its key line(s), "sr1:<publicKey>:<signingKey>", newest first
//
// When the receiver moves to another address, its GET /v1/config answers
// with a "moved to" notice signed by its long-term signing key; the Manager
// follows it only when that signature checks out against a key below, so a
// hijacked domain cannot send reports elsewhere. (REPORTS_URL set by hand is
// never moved.)

const { normalizeKey, parseKeyLine } = require('./reportsProtocol');

const DEFAULT_ENDPOINT = 'https://reports.skittles.live';

const RECEIVER_KEYS = [
  // reports.skittles.live, first key (sr1:vwM+s1D0…:cy6caX77…)
  { kid: '208993f9bb2c38d1', publicKey: 'vwM+s1D0pRqmxCJn8usIqDpkRp1yWIi61FptVfk88Sg=', signingKey: 'cy6caX77BNO5cPuE1GA6d/D68zl2zwXZL2HV4G8AA/k=' }
];

/** The endpoint and keys in force: { endpoint, keys, fromEnv, error }. */
function reportsConfig(env = process.env) {
  const out = { endpoint: DEFAULT_ENDPOINT, keys: [], fromEnv: { url: false, key: false }, error: null };
  try {
    if (env.REPORTS_URL) {
      out.endpoint = checkEndpoint(env.REPORTS_URL, env);
      out.fromEnv.url = true;
    }
    // REPORTS=off: no reporting at all on this server, whatever the build has
    if (/^(off|false|0|no)$/i.test(String(env.REPORTS || ''))) { out.off = true; return out; }
    out.keys = env.REPORTS_PUBLIC_KEY ? parseKeyLine(env.REPORTS_PUBLIC_KEY) : RECEIVER_KEYS.map(normalizeKey);
    out.fromEnv.key = Boolean(env.REPORTS_PUBLIC_KEY);
  } catch (err) {
    out.error = err.message;
    out.keys = [];
  }
  return out;
}

/** An endpoint as used: https://host[:port][/path] with no trailing slash; http only for localhost under NODE_ENV=test. */
function checkEndpoint(value, env = process.env) {
  let u;
  try {
    u = new URL(String(value).trim());
  } catch {
    throw new Error('REPORTS_URL is not an address.');
  }
  const testLocal = u.protocol === 'http:' && env.NODE_ENV === 'test' && ['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname);
  if (u.protocol !== 'https:' && !testLocal) throw new Error('REPORTS_URL must be https://.');
  if (u.username || u.password || u.search || u.hash) throw new Error('REPORTS_URL takes no user name, query or #.');
  return `${u.origin}${u.pathname.replace(/\/+$/, '')}`;
}

module.exports = { DEFAULT_ENDPOINT, RECEIVER_KEYS, reportsConfig, checkEndpoint };
