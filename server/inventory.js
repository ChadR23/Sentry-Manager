'use strict';

// Recordings per vehicle, built from a scan of its footage:
//   - each Sentry / Saved event folder is one recording;
//   - Recent (and other) clips are grouped into continuous sessions: a gap
//     of more than ~90 s between one-minute clips starts a new recording.
// After each scan the clips' video codecs are read from their MP4 headers
// in the background (remembered per file size and time, so only new or
// changed clips are read), which tells encoded recordings from originals.
// Each scan's files and the codecs read are also kept in the database's
// footage catalog (catalog.js), so codecs are not read again after a restart.

const crypto = require('crypto');
const fsp = require('fs/promises');
const path = require('path');
const { scanFootage, limiter } = require('./scanner');
const { BATCH } = require('./catalog');
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
  constructor({ vehicles, db, log, onChange = () => {}, onScanned = () => {} }) {
    this.vehicles = vehicles;
    this.db = db;
    this.log = log;
    this.onChange = onChange;
    this.onScanned = onScanned;
    this.state = new Map(); // vehicleId -> { files, recordings, scannedAt, durationMs, errors, scanning }
    this.scans = new Map();
    this.codecMaps = new Map(); // vehicleId -> Map(rel -> { size, mtimeMs, codec })
    this.probing = new Map();
    this.catalogBehind = new Set(); // vehicles whose last catalog write failed
  }

  /** The database's footage catalog (catalog.js), when there is one (not in some tests). */
  get catalog() {
    return this.db?.catalog || null;
  }

  /**
   * The vehicle's clip codecs read so far (rel -> { size, mtimeMs, codec }).
   * Once a clip's codec is known for the size and time the scan found, its
   * value is the scan's own file entry (which has those three), not a copy.
   */
  codecs(vehicleId) {
    if (!this.codecMaps.has(vehicleId)) {
      const map = new Map();
      const cat = this.catalog;
      const saved = cat && cat.hasCodecs(vehicleId) ? null : this.db.get(`codecs:${vehicleId}`, {});
      if (saved) {
        // the map as one settings value (before the catalog): moved into the catalog once
        for (const [rel, v] of Object.entries(saved || {})) {
          if (Array.isArray(v) && v.length === 3) map.set(rel, { size: v[0], mtimeMs: v[1], codec: v[2] });
        }
        if (cat && map.size) {
          cat.putCodecs(vehicleId, [...map].map(([rel, v]) => ({ rel, ...v })));
          this.db.del(`codecs:${vehicleId}`);
        }
      } else {
        // (a settings value an older version wrote after this one moved them: the catalog is used)
        this.db.del(`codecs:${vehicleId}`);
        // the same path strings as the scan's, when it has been scanned
        const files = this.state.get(vehicleId)?.files;
        for (const c of cat.codecs(vehicleId)) {
          const f = files?.get(c.rel);
          if (f && f.size === c.size && f.mtimeMs === c.mtimeMs) {
            f.codec = c.codec;
            map.set(f.rel, f);
          } else map.set(f ? f.rel : c.rel, { size: c.size, mtimeMs: c.mtimeMs, codec: c.codec });
        }
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
      const cat = this.catalog;
      const gone = [];
      for (const rel of map.keys()) if (!entry.files.has(rel) && map.delete(rel)) gone.push(rel);
      const todo = [];
      for (const f of entry.files.values()) {
        if (f.kind !== 'clip' || !/\.mp4$/i.test(f.rel)) continue;
        const known = map.get(f.rel);
        if (!(known?.size === f.size && known?.mtimeMs === f.mtimeMs)) todo.push(f);
        else if (known !== f) {
          // known for this size and time: kept on the scan's entry, the copy (and its path string) let go
          f.codec = known.codec;
          map.delete(f.rel);
          map.set(f.rel, f);
        }
      }
      const limit = limiter(this.codecChecks || 8); // (index.js sets it from workLimits.js)
      const read = [];
      await Promise.all(todo.map((f) => limit(async () => {
        try {
          const codec = await videoCodec(safeJoin(root, f.rel));
          f.codec = codec;
          map.delete(f.rel);
          map.set(f.rel, f);
          read.push(f);
          // remembered as it goes, so a restart halfway through keeps what was read
          if (cat && read.length % BATCH === 0) cat.putCodecs(vehicleId, read.slice(-BATCH));
        } catch {
          // unreadable right now (share dropped, file being replaced): next scan
        }
      })));
      if (cat) {
        if (read.length % BATCH) cat.putCodecs(vehicleId, read.slice(-(read.length % BATCH)));
        cat.removeCodecs(vehicleId, gone);
      } else if (read.length || gone.length) {
        // no catalog (some tests): the map as one settings value, saved only when something changed
        this.db.set(`codecs:${vehicleId}`, Object.fromEntries([...map].map(([rel, v]) => [rel, [v.size, v.mtimeMs, v.codec]])));
      }
      if (read.length) this.onChange(vehicleId);
      return read.length;
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

  // `light`: the background rescan (index.js, every 15 minutes) reuses what
  // the last scan knew of unchanged folders (scanner.js); every sixth, about
  // every 90 minutes, and every other scan (Refresh, a policy, a restore)
  // looks at every file.
  scan(vehicleId, { light = false } = {}) {
    if (this.scans.has(vehicleId)) return this.scans.get(vehicleId);
    const p = (async () => {
      const vehicle = this.vehicles.get(vehicleId);
      if (!vehicle) throw Object.assign(new Error('No such vehicle.'), { status: 404 });
      const share = this.vehicles.share(vehicleId);
      if (share && !share.isHealthy()) throw Object.assign(new Error(`${vehicle.name}: the share is not available.`), { status: 503 });
      const prev = this.state.get(vehicleId);
      this.state.set(vehicleId, { ...(prev || {}), scanning: true });
      try {
        const lights = prev?.lightScans || 0;
        const reuse = light && prev?.files && prev?.dirs && lights < 5;
        const toCatalog = this.catalogWriter(vehicleId, prev?.files);
        const res = await scanFootage(this.vehicles.rootOf(vehicle), {
          onFile: toCatalog?.add,
          ...(reuse ? { previous: { files: prev.files, dirs: prev.dirs } } : {})
        });
        toCatalog?.finish(res.files);
        const entry = {
          files: res.files,
          dirs: res.dirs,
          lightScans: reuse ? lights + 1 : 0,
          scannedAt: res.scannedAt,
          durationMs: res.durationMs,
          errors: res.errors.slice(0, 20),
          errorCount: res.errors.length,
          scanning: false
        };
        entry.recordings = buildRecordings(res.files, { vehicleId, protectedRels: this.db.protectedSet(vehicleId) });
        this.state.set(vehicleId, entry);
        this.log.info(`${vehicle.name}: ${entry.recordings.length} recordings, ${res.files.size} files (${(res.durationMs / 1000).toFixed(1)}s${reuse ? `, ${res.reused} unchanged` : ''})`);
        this.probeCodecs(vehicleId);
        this.onScanned(vehicleId);
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

  /**
   * Keeps the catalog in step with a scan: the files it looks at afresh are
   * written in batches as it goes (unless the last scan saw them just so),
   * and at the end the files it did not find are forgotten. A failure here
   * never fails the scan: the catalog is caught up by the next one.
   */
  catalogWriter(vehicleId, prevFiles) {
    const cat = this.catalog;
    if (!cat) return null;
    // the last write failed: this scan writes every file, not only what changed
    if (this.catalogBehind.has(vehicleId)) prevFiles = null;
    let batch = [];
    let failed = false;
    const write = (fn) => {
      if (failed) return;
      try {
        fn();
      } catch (err) {
        failed = true;
        this.catalogBehind.add(vehicleId);
        this.log.warn(`Footage catalog not updated: ${err.message}`);
      }
    };
    const flush = () => {
      const list = batch;
      batch = [];
      if (list.length) write(() => cat.putFiles(vehicleId, list));
    };
    return {
      add: (f) => {
        const was = prevFiles?.get(f.rel);
        if (was && was.size === f.size && was.mtimeMs === f.mtimeMs && was.ctimeMs === f.ctimeMs && was.birthtimeMs === f.birthtimeMs
          && was.day === f.day && was.kind === f.kind) return;
        batch.push(f);
        if (batch.length >= BATCH) flush();
      },
      finish: (files) => {
        flush();
        write(() => cat.keepOnly(vehicleId, (rel) => files.has(rel)));
        if (!failed) this.catalogBehind.delete(vehicleId);
      }
    };
  }

  /** Recompute recordings after files moved (trash/restore) without rescanning. */
  rebuild(vehicleId) {
    const entry = this.state.get(vehicleId);
    if (!entry?.files) return;
    entry.recordings = buildRecordings(entry.files, { vehicleId, protectedRels: this.db.protectedSet(vehicleId) });
    // the catalog too, so it doesn't wait for the next scan (a failure only means the next scan writes every file)
    const cat = this.catalog;
    if (cat && !this.catalogBehind.has(vehicleId)) {
      try {
        cat.syncFiles(vehicleId, entry.files);
      } catch (err) {
        this.catalogBehind.add(vehicleId);
        this.log.warn(`Footage catalog not updated: ${err.message}`);
      }
    }
  }

  recording(vehicleId, id) {
    return this.state.get(vehicleId)?.recordings?.find((r) => r.id === id) || null;
  }

  totals(vehicleId) {
    const e = this.state.get(vehicleId);
    if (!e?.recordings) return null;
    const by = {};
    const days = this.footageDays(vehicleId);
    for (const r of e.recordings) {
      by[r.category] = by[r.category] || { recordings: 0, bytes: 0 };
      by[r.category].recordings++;
      by[r.category].bytes += r.bytes;
    }
    return {
      recordings: e.recordings.length,
      // days with any footage (the car's own dates), and the first and last
      days: days.length,
      firstDay: days[0] || null,
      lastDay: days[days.length - 1] || null,
      files: e.files.size,
      bytes: e.recordings.reduce((n, r) => n + r.bytes, 0),
      // the length of all the footage in minutes (one a clip minute: the days' minutes, the Dash's "footage hours" x 60)
      minutes: e.recordings.reduce((n, r) => n + (r.minutes || 0), 0),
      byCategory: by,
      scannedAt: e.scannedAt
    };
  }

  /**
   * The clips (one a camera file) that reached the share since `sinceMs`:
   * { sentry (SentryClips), dashcam (everything else: RecentClips, SavedClips, ...) }.
   * When a clip arrived is its birth time, else its ctime (the archive keeps
   * the car's mtime), as arrivalChecksums.js reads it.
   */
  arrivedClips(vehicleId, sinceMs) {
    const out = { sentry: 0, dashcam: 0 };
    const e = this.state.get(vehicleId);
    if (!e?.files) return out;
    for (const f of e.files.values()) {
      if (f.kind !== 'clip') continue;
      const at = f.birthtimeMs > 0 ? f.birthtimeMs : f.ctimeMs || 0;
      if (!(at >= sinceMs)) continue;
      if (f.type === 'SentryClips') out.sentry++;
      else out.dashcam++;
    }
    return out;
  }

  /** The days ("YYYY-MM-DD", oldest first) with any recording of a vehicle. */
  footageDays(vehicleId) {
    const e = this.state.get(vehicleId);
    if (!e?.recordings) return [];
    return [...new Set(e.recordings.map((r) => r.day).filter(Boolean))].sort();
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
