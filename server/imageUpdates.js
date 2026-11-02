'use strict';

// Updates come as new images: `docker compose pull && docker compose up -d`
// (or a tool like Watchtower). This only tells the owner when one is out.
//
// The release build records which image and tag it made (BUILD_INFO.json).
// Twice a day this asks that registry, anonymously, which image the tag
// points to now and compares its revision and build time with ours: a new
// release (images are only built for one, never on a timer). Nothing is downloaded or installed and no token is stored.
// UPDATE_CHECK=off turns it off; images built locally have no tag to check.

const CHECK_MS = 12 * 3600 * 1000;
// soon after a start too (not only 12 hours after the last check): a critical
// update shows within minutes of the server coming up
const STARTUP_CHECK_MS = 10 * 60 * 1000;
const CRITICAL_LABEL = 'io.sentry-six.critical';
const CRITICAL_LEVEL_LABEL = 'io.sentry-six.critical-level';
const MAX_LEVEL = 999999;
const CRITICAL_MAX = 300;
const MIN_CHECK_GAP_MS = 60 * 1000;
const MAX_BODY = 1024 * 1024;
const ACCEPT = [
  'application/vnd.oci.image.index.v1+json',
  'application/vnd.docker.distribution.manifest.list.v2+json',
  'application/vnd.oci.image.manifest.v1+json',
  'application/vnd.docker.distribution.manifest.v2+json'
].join(', ');
const IMAGE_RE = /^([a-z0-9.-]+\.[a-z]{2,}(?::\d+)?)\/([a-z0-9._/-]+)$/;
const TAG_RE = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/;
const DIGEST_RE = /^sha256:[a-f0-9]{64}$/;
const ARCH = { x64: 'amd64', arm64: 'arm64' }[process.arch] || process.arch;

/** The parameters of a `Bearer realm="…",service="…",scope="…"` challenge. */
function parseChallenge(header) {
  if (!/^Bearer\s/i.test(header || '')) return null;
  const out = {};
  for (const m of header.matchAll(/(\w+)="([^"]*)"/g)) out[m[1].toLowerCase()] = m[2];
  return out.realm ? out : null;
}

/** A label's text as plain, single-line, short text (or null when empty). */
function cleanCritical(value) {
  if (typeof value !== 'string') return null;
  const t = value.replace(/[\x00-\x1f\x7f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, CRITICAL_MAX).trim();
  return t || null;
}

/** A critical level: a whole number from 0 (none); anything else is 0. */
function cleanLevel(value) {
  const t = String(value ?? '').trim();
  return /^\d{1,6}$/.test(t) ? Math.min(Number(t), MAX_LEVEL) : 0;
}

/**
 * CRITICAL_UPDATE.txt as the image build reads it (.github/workflows/image.yml,
 * the `names` job): `level: N` and `reason: text` lines, lines starting with #
 * are comments. The reason is made one line without quotes, backslashes or
 * control characters, commas become semicolons. A level without a reason is 0.
 */
function criticalFromFile(text) {
  let level = 0;
  let reason = null;
  for (const line of String(text || '').split(/\r?\n/)) {
    if (/^\s*#/.test(line)) continue;
    const m = /^\s*(level|reason):(.*)$/i.exec(line);
    if (!m) continue;
    if (m[1].toLowerCase() === 'level') level = cleanLevel(m[2]);
    else reason = cleanCritical(m[2].replace(/[\x00-\x1f\x7f"'`\\]/g, (c) => (c === '\t' || c === '\r' ? ' ' : '')).replace(/,/g, ';'));
  }
  return level > 0 && reason ? { level, reason } : { level: 0, reason: null };
}

class ImageUpdates {
  constructor({ db, log, buildInfo = {}, notes = null, enabled = true, fetchImpl = globalThis.fetch, ownCritical = null }) {
    this.db = db;
    this.log = log;
    this.notes = notes;
    this.fetch = fetchImpl;
    const m = IMAGE_RE.exec(String(buildInfo.image || ''));
    this.registry = m?.[1] || null;
    this.repo = m?.[2] || null;
    this.tag = TAG_RE.test(String(buildInfo.tag || '')) ? buildInfo.tag : null;
    this.current = { sha: buildInfo.sha || null, builtAt: buildInfo.builtAt || null };
    this.enabled = enabled && Boolean(this.registry && this.repo && this.tag);
    this.state = db.get('image-updates', { latest: null, checkedAt: 0, error: null });
    this.lastCheck = 0;
    this.startedAt = Date.now();
    // the critical level this image was built with (CRITICAL_UPDATE.txt);
    // images from before critical levels have none: 0
    this.ownLevel = cleanLevel(ownCritical?.level);
  }

  status() {
    return {
      enabled: this.enabled,
      image: this.repo ? `${this.registry}/${this.repo}` : null,
      tag: this.tag,
      current: this.current,
      latest: this.state.latest,
      checkedAt: this.state.checkedAt || null,
      error: this.state.error,
      updateAvailable: this.updateAvailable(),
      critical: this.critical()
    };
  }

  /**
   * `{ level, reason, created }` while an image with a critical fix this one
   * lacks is out, else null. Sticky: every later image carries the level of
   * the last critical release, and the highest level seen is remembered, so
   * a newer ordinary release (or one that lost the labels by mistake) never
   * hides it. Only running a build with that level or a higher one clears it.
   */
  critical() {
    const c = this.state.critical;
    if (!this.enabled || !c || cleanLevel(c.level) <= this.ownLevel) return null;
    return { level: cleanLevel(c.level), reason: cleanCritical(c.reason) || 'A critical fix is out.', created: c.created || null };
  }

  updateAvailable() {
    const latest = this.state.latest;
    if (!this.enabled || !latest) return false;
    if (latest.revision && this.current.sha && latest.revision !== this.current.sha) return true;
    const a = Date.parse(latest.created || '');
    const b = Date.parse(this.current.builtAt || '');
    return Number.isFinite(a) && Number.isFinite(b) && a > b;
  }

  async tick() {
    if (!this.enabled) return;
    const since = Date.now() - (this.state.checkedAt || 0);
    const firstSinceStart = (this.state.checkedAt || 0) < this.startedAt;
    if (since >= CHECK_MS || (firstSinceStart && since >= STARTUP_CHECK_MS)) await this.check().catch(() => {});
  }

  async check() {
    if (!this.enabled) return this.status();
    if (Date.now() - this.lastCheck < MIN_CHECK_GAP_MS) return this.status();
    this.lastCheck = Date.now();
    try {
      const latest = await this.fetchLatest();
      const seen = this.state.critical;
      const critical = latest.criticalLevel > cleanLevel(seen?.level)
        ? { level: latest.criticalLevel, reason: latest.critical, created: latest.created }
        : seen || null;
      this.state = { latest, critical, checkedAt: Date.now(), error: null };
    } catch (err) {
      this.state = { ...this.state, checkedAt: Date.now(), error: err.message };
      this.log?.warn(`Could not check for a newer image: ${err.message}`);
    }
    this.db.set('image-updates', this.state);
    this.announce();
    return this.status();
  }

  /** Raise the notification while an update is out, clear it once installed. */
  announce() {
    if (!this.notes) return;
    const critical = this.critical();
    if (critical) {
      this.notes.raise({
        kind: 'update', level: 'critical', dedupeKey: 'image-update-critical',
        title: 'Critical update: install now',
        message: `${critical.reason} To install it, run "docker compose pull && docker compose up -d" where you set up Sentry Six Manager (TrueNAS: see Updates in the README).`
      });
    } else {
      this.notes.resolve('image-update-critical');
    }
    if (!this.updateAvailable()) return this.notes.resolve('image-update');
    const l = this.state.latest;
    this.notes.raise({
      kind: 'update', level: 'info', dedupeKey: 'image-update',
      title: 'An update is available',
      message: `A newer ${this.tag} image was published${l.created ? ` on ${l.created.slice(0, 10)}` : ''}. To install it, run "docker compose pull && docker compose up -d" where you set up Sentry Six Manager.`
    });
    return undefined;
  }

  async request(url, headers = {}) {
    const res = await this.fetch(url, { headers: { 'User-Agent': 'sentry-six-manager', ...headers }, redirect: 'follow', signal: AbortSignal.timeout(20000) });
    const text = await res.text();
    if (text.length > MAX_BODY) throw new Error('the registry answered with too much data');
    return { status: res.status, headers: res.headers, text };
  }

  async fetchLatest() {
    const base = `https://${this.registry}/v2/${this.repo}`;
    let auth = {};
    const get = async (p, accept) => {
      let r = await this.request(`${base}/${p}`, { Accept: accept, ...auth });
      if (r.status === 401 && !auth.Authorization) {
        const ch = parseChallenge(r.headers.get('www-authenticate'));
        if (!ch) throw new Error('the registry asked for a sign-in this check cannot do');
        const realm = new URL(ch.realm);
        if (realm.protocol !== 'https:') throw new Error('the registry offered a sign-in without HTTPS');
        if (ch.service) realm.searchParams.set('service', ch.service);
        realm.searchParams.set('scope', ch.scope || `repository:${this.repo}:pull`);
        const t = await this.request(realm.href);
        const body = t.status === 200 ? JSON.parse(t.text) : {};
        const token = body.token || body.access_token;
        if (!token) throw new Error(`the registry refused an anonymous check (${t.status}); is the image public?`);
        auth = { Authorization: `Bearer ${token}` };
        r = await this.request(`${base}/${p}`, { Accept: accept, ...auth });
      }
      if (r.status === 404) throw new Error(`no image tagged ${this.tag}`);
      if (r.status !== 200) throw new Error(`the registry answered ${r.status}`);
      return { json: JSON.parse(r.text), digest: r.headers.get('docker-content-digest') };
    };

    let { json: manifest, digest } = await get(`manifests/${encodeURIComponent(this.tag)}`, ACCEPT);
    if (Array.isArray(manifest.manifests)) {
      const mine = manifest.manifests.find((m) => m.platform?.os === 'linux' && m.platform?.architecture === ARCH);
      if (!mine || !DIGEST_RE.test(mine.digest)) throw new Error(`the ${this.tag} image has no linux/${ARCH} build`);
      digest = mine.digest;
      ({ json: manifest } = await get(`manifests/${mine.digest}`, ACCEPT));
    }
    const configDigest = manifest.config?.digest;
    if (!DIGEST_RE.test(configDigest || '')) throw new Error('the registry sent an unexpected manifest');
    const { json: config } = await get(`blobs/${configDigest}`, 'application/json');
    const labels = config.config?.Labels || {};
    const revision = labels['org.opencontainers.image.revision'] || null;
    return {
      digest: DIGEST_RE.test(digest || '') ? digest : configDigest,
      revision: /^[a-f0-9]{7,64}$/.test(revision || '') ? revision : null,
      created: labels['org.opencontainers.image.created'] || config.created || null,
      ...(() => {
        const reason = cleanCritical(labels[CRITICAL_LABEL]);
        const level = reason ? cleanLevel(labels[CRITICAL_LEVEL_LABEL]) : 0;
        return { criticalLevel: level, critical: level ? reason : null };
      })()
    };
  }
}

module.exports = { ImageUpdates, parseChallenge, cleanCritical, cleanLevel, criticalFromFile, CRITICAL_LABEL, CRITICAL_LEVEL_LABEL };
