'use strict';

// Recordings per vehicle, built from a scan of its footage:
//   - each Sentry / Saved event folder is one recording;
//   - Recent (and other) clips are grouped into continuous sessions: a gap
//     of more than ~90 s between one-minute clips starts a new recording.
// After each scan the clips' video codecs are read from their MP4 headers
// in the background (remembered per file size and time, so only new or
// changed clips are read), which tells encoded recordings from originals.

const crypto = require('crypto');
const fsp = require('fs/promises');
const path = require('path');
const { scanFootage, limiter } = require('./scanner');
const { safeJoin } = require('./footage');
const { videoCodec } = require('./mp4codec');

const TS_RE = /(\d{4}-\d{2}-\d{2})_(\d{2})-(\d{2})-(\d{2})/;
const CATEGORY = { RecentClips: 'Recent', SentryClips: 'Sentry', SavedClips: 'Saved', Other: 'Other' };
const SESSION_GAP_S = 90;
const ENCODED = new Set(['h265', 'av1']);

function tsFrom(name) {
  const m = String(name).match(TS_RE);
  return m ? `${m[1]}_${m[2]}-${m[3]}-${m[4]}` : null;
}

/** Seconds since epoch of a wall-clock key, treating it as UTC (only differences matter). */
function keySeconds(key) {
  const m = key.match(/^(\d{4})-(\d{2})-(\d{2})_(\d{2})-(\d{2})-(\d{2})$/);
  return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]) / 1000;
}

const display = (key) => (key ? `${key.slice(0, 10)} ${key.slice(11).replace(/-/g, ':')}` : null);
const hashId = (s) => crypto.createHash('sha1').update(s).digest('hex').slice(0, 16);

/** Group a scan's file map into recordings (newest first). */
function buildRecordings(files, { vehicleId, protectedRels = new Set() } = {}) {
  const events = new Map();
  const loose = new Map(); // dir -> [{file, ts}]
  for (const f of files.values()) {
    const dir = path.posix.dirname(f.rel);
    if (f.eventId && (f.type === 'SentryClips' || f.type === 'SavedClips')) {
      if (!events.has(dir)) events.set(dir, []);
      events.get(dir).push(f);
    } else {
      const ts = tsFrom(path.posix.basename(f.rel));
      if (!ts) continue;
      if (!loose.has(dir)) loose.set(dir, []);
      loose.get(dir).push({ f, ts });
    }
  }

  const recordings = [];
  const finish = (key, type, folder, list, startKey) => {
    const clips = list.filter((f) => f.kind === 'clip');
    const stamps = clips.map((f) => tsFrom(path.posix.basename(f.rel))).filter(Boolean).sort();
    const rels = list.map((f) => f.rel).sort();
    const cameras = [...new Set(clips.map((f) => f.camera).filter(Boolean))].sort();
    const thumb = list.find((f) => /\/thumb\.png$/i.test(f.rel));
    recordings.push({
      id: hashId(`${vehicleId}|${key}`),
      key,
      vehicleId,
      type,
      category: CATEGORY[type] || 'Other',
      folder,
      eventId: list[0].eventId || null,
      // the clip range; for events the folder name is when Sentry/Save triggered
      startKey: stamps[0] || startKey || null,
      start: display(stamps[0] || startKey),
      end: display(stamps[stamps.length - 1] || startKey),
      eventAt: list[0].eventId ? display(startKey) : null,
      day: (stamps[0] || startKey || '').slice(0, 10) || list[0].day,
      files: rels,
      fileCount: rels.length,
      clipCount: clips.length,
      minutes: new Set(stamps).size, // Tesla clips are one minute each
      clipRels: clips.map((f) => f.rel),
      bytes: list.reduce((n, f) => n + f.size, 0),
      cameras,
      thumbRel: thumb ? thumb.rel : null,
      frontRel: (clips.find((f) => f.camera === 'front') || clips[0])?.rel || null,
      protected: rels.some((r) => protectedRels.has(r)),
      mtimeMs: Math.max(...list.map((f) => f.mtimeMs))
    });
  };

  for (const [dir, list] of events) {
    const eventFolder = path.posix.basename(dir);
    finish(`event:${dir}`, list[0].type, dir, list, tsFrom(eventFolder));
  }
  for (const [dir, entries] of loose) {
    entries.sort((a, b) => a.ts.localeCompare(b.ts));
    let session = [];
    let last = null;
    const flush = () => {
      if (!session.length) return;
      finish(`session:${dir}:${session[0].ts}`, session[0].f.type, dir, session.map((e) => e.f), session[0].ts);
      session = [];
    };
    for (const e of entries) {
      const t = keySeconds(e.ts);
      if (last !== null && t - last > SESSION_GAP_S) flush();
      session.push(e);
      last = t;
    }
    flush();
  }
  recordings.sort((a, b) => String(b.startKey).localeCompare(String(a.startKey)));
  return recordings;
}

/** How many of a recording's clips are encoded, by codec map (rel -> codec). */
function encodedOf(rec, codecs) {
  const out = { clips: rec.clipRels.length, encoded: 0, unknown: 0, codecs: [] };
  const seen = new Set();
  for (const rel of rec.clipRels) {
    const codec = codecs?.get(rel)?.codec;
    if (codec === undefined) out.unknown++;
    else if (ENCODED.has(codec)) {
      out.encoded++;
      seen.add(codec);
    }
  }
  out.codecs = [...seen].sort();
  return out;
}

/**
 * One entry per capture day (newest first): counts per category, size,
 * minutes, encoded clips, and the recording whose thumbnail stands for the
 * day (its first Sentry or Saved event, else its first drive).
 */
function summarizeDays(recordings, codecs) {
  const days = new Map();
  for (const rec of recordings) {
    if (!days.has(rec.day)) {
      days.set(rec.day, { day: rec.day, recordings: 0, byCategory: {}, bytes: 0, minutes: 0, clips: 0, encoded: 0, encodedRecordings: 0, unknown: 0, codecs: new Set(), cameras: 0, protected: 0, list: [] });
    }
    const d = days.get(rec.day);
    const enc = encodedOf(rec, codecs);
    d.recordings++;
    d.byCategory[rec.category] = (d.byCategory[rec.category] || 0) + 1;
    d.bytes += rec.bytes;
    d.minutes += rec.minutes;
    d.clips += enc.clips;
    d.encoded += enc.encoded;
    if (enc.clips > 0 && enc.encoded === enc.clips) d.encodedRecordings++;
    d.unknown += enc.unknown;
    enc.codecs.forEach((c) => d.codecs.add(c));
    d.cameras = Math.max(d.cameras, rec.cameras.length);
    if (rec.protected) d.protected++;
    d.list.push(rec);
  }
  return [...days.values()].sort((a, b) => b.day.localeCompare(a.day)).map(({ list, codecs: used, ...d }) => {
    const byTime = [...list].sort((a, b) => String(a.startKey).localeCompare(String(b.startKey)));
    const thumb = byTime.find((r) => r.category === 'Sentry' || r.category === 'Saved') || byTime[0];
    return { ...d, codecs: [...used].sort(), thumbId: thumb?.id || null };
  });
}

class Inventory {
  constructor({ vehicles, db, log, onChange = () => {} }) {
    this.vehicles = vehicles;
    this.db = db;
    this.log = log;
    this.onChange = onChange;
    this.state = new Map(); // vehicleId -> { files, recordings, scannedAt, durationMs, errors, scanning }
    this.scans = new Map();
    this.codecMaps = new Map(); // vehicleId -> Map(rel -> { size, mtimeMs, codec })
    this.probing = new Map();
  }

  /** The vehicle's clip codecs read so far (rel -> { size, mtimeMs, codec }). */
  codecs(vehicleId) {
    if (!this.codecMaps.has(vehicleId)) {
      const saved = this.db.get(`codecs:${vehicleId}`, {});
      const map = new Map();
      for (const [rel, v] of Object.entries(saved || {})) {
        if (Array.isArray(v) && v.length === 3) map.set(rel, { size: v[0], mtimeMs: v[1], codec: v[2] });
      }
      this.codecMaps.set(vehicleId, map);
    }
    return this.codecMaps.get(vehicleId);
  }

  /**
   * Read the codec of every clip that is new or changed since it was last
   * read; forget clips that are gone. Runs in the background after a scan.
   */
  probeCodecs(vehicleId) {
    if (this.probing.has(vehicleId)) return this.probing.get(vehicleId);
    const p = (async () => {
      const entry = this.state.get(vehicleId);
      const vehicle = this.vehicles.get(vehicleId);
      if (!entry?.files || !vehicle) return 0;
      const root = this.vehicles.rootOf(vehicle);
      const map = this.codecs(vehicleId);
      for (const rel of map.keys()) if (!entry.files.has(rel)) map.delete(rel);
      const todo = [...entry.files.values()].filter((f) => f.kind === 'clip' && /\.mp4$/i.test(f.rel)
        && !(map.get(f.rel)?.size === f.size && map.get(f.rel)?.mtimeMs === f.mtimeMs));
      const limit = limiter(8);
      let read = 0;
      await Promise.all(todo.map((f) => limit(async () => {
        try {
          const codec = await videoCodec(safeJoin(root, f.rel));
          map.set(f.rel, { size: f.size, mtimeMs: f.mtimeMs, codec });
          read++;
        } catch {
          // unreadable right now (share dropped, file being replaced): next scan
        }
      })));
      this.db.set(`codecs:${vehicleId}`, Object.fromEntries([...map].map(([rel, v]) => [rel, [v.size, v.mtimeMs, v.codec]])));
      if (read) this.onChange(vehicleId);
      return read;
    })().catch((err) => {
      this.log.warn(`Reading clip codecs failed: ${err.message}`);
      return 0;
    }).finally(() => this.probing.delete(vehicleId));
    this.probing.set(vehicleId, p);
    return p;
  }

  encoded(vehicleId, rec) {
    return encodedOf(rec, this.codecs(vehicleId));
  }

  days(vehicleId, recordings) {
    return summarizeDays(recordings, this.codecs(vehicleId));
  }

  get(vehicleId) {
    return this.state.get(vehicleId) || null;
  }

  scan(vehicleId) {
    if (this.scans.has(vehicleId)) return this.scans.get(vehicleId);
    const p = (async () => {
      const vehicle = this.vehicles.get(vehicleId);
      if (!vehicle) throw Object.assign(new Error('No such vehicle.'), { status: 404 });
      const share = this.vehicles.share(vehicleId);
      if (share && !share.isHealthy()) throw Object.assign(new Error(`${vehicle.name}: the share is not available.`), { status: 503 });
      const prev = this.state.get(vehicleId);
      this.state.set(vehicleId, { ...(prev || {}), scanning: true });
      try {
        const res = await scanFootage(this.vehicles.rootOf(vehicle));
        const entry = {
          files: res.files,
          scannedAt: res.scannedAt,
          durationMs: res.durationMs,
          errors: res.errors.slice(0, 20),
          errorCount: res.errors.length,
          scanning: false
        };
        entry.recordings = buildRecordings(res.files, { vehicleId, protectedRels: this.db.protectedSet(vehicleId) });
        this.state.set(vehicleId, entry);
        this.log.info(`${vehicle.name}: ${entry.recordings.length} recordings, ${res.files.size} files (${(res.durationMs / 1000).toFixed(1)}s)`);
        this.probeCodecs(vehicleId);
        return entry;
      } catch (err) {
        this.state.set(vehicleId, { ...(prev || {}), scanning: false, lastError: err.message });
        throw err;
      } finally {
        this.scans.delete(vehicleId);
      }
    })();
    this.scans.set(vehicleId, p);
    return p;
  }

  /** Recompute recordings after files moved (trash/restore) without rescanning. */
  rebuild(vehicleId) {
    const entry = this.state.get(vehicleId);
    if (!entry?.files) return;
    entry.recordings = buildRecordings(entry.files, { vehicleId, protectedRels: this.db.protectedSet(vehicleId) });
  }

  recording(vehicleId, id) {
    return this.state.get(vehicleId)?.recordings?.find((r) => r.id === id) || null;
  }

  totals(vehicleId) {
    const e = this.state.get(vehicleId);
    if (!e?.recordings) return null;
    const by = {};
    for (const r of e.recordings) {
      by[r.category] = by[r.category] || { recordings: 0, bytes: 0 };
      by[r.category].recordings++;
      by[r.category].bytes += r.bytes;
    }
    return {
      recordings: e.recordings.length,
      files: e.files.size,
      bytes: e.recordings.reduce((n, r) => n + r.bytes, 0),
      byCategory: by,
      scannedAt: e.scannedAt
    };
  }

  /** event.json of a Sentry/Saved event, if present and small. */
  async eventInfo(vehicleId, recording) {
    if (!recording.eventId) return null;
    const vehicle = this.vehicles.get(vehicleId);
    const rel = recording.files.find((r) => /\/event\.json$/i.test(r));
    if (!vehicle || !rel) return null;
    try {
      const abs = safeJoin(this.vehicles.rootOf(vehicle), rel);
      const st = await fsp.stat(abs);
      if (st.size > 64 * 1024) return null;
      const data = JSON.parse(await fsp.readFile(abs, 'utf8'));
      const pick = {};
      for (const k of ['timestamp', 'city', 'street', 'est_lat', 'est_lon', 'reason', 'camera']) {
        if (data[k] !== undefined && data[k] !== null) pick[k] = String(data[k]).slice(0, 200);
      }
      return pick;
    } catch {
      return null;
    }
  }
}

module.exports = { Inventory, buildRecordings, summarizeDays, encodedOf, tsFrom };
