'use strict';

// Retention policies per vehicle: "keep Recent clips N days" etc. A policy
// MOVES old recordings to the Recycle Bin; protected recordings are skipped.
// Nothing is deleted for good unless the user empties the bin, or turns on
// "empty the Recycle Bin after N days" (binDays): then, at the policy's run,
// what has sat in the bin longer than that is deleted.

const CATEGORIES = ['Recent', 'Sentry', 'Saved', 'Other'];

function defaultPolicy() {
  return { enabled: false, runAt: '03:30', keepDays: { Recent: null, Sentry: null, Saved: null, Other: null }, binDays: null, maxGB: null, lastRunAt: null, lastResult: null };
}

/** What decides what a run moves or deletes: equal keys mean the same rule. */
function ruleKey(p) {
  const n = (v) => (v === undefined || v === '' ? null : v === null ? null : Number(v));
  const keep = (p && p.keepDays) || {};
  return JSON.stringify({ keepDays: CATEGORIES.map((c) => n(keep[c])), binDays: n(p && p.binDays), maxGB: n(p && p.maxGB) });
}

function normalizePolicy(input, prev = defaultPolicy()) {
  const out = { ...prev, keepDays: { ...prev.keepDays } };
  if (input.enabled !== undefined) out.enabled = Boolean(input.enabled);
  if (input.runAt !== undefined) {
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(String(input.runAt))) throw Object.assign(new Error('Run time must be HH:MM.'), { status: 400 });
    out.runAt = String(input.runAt);
  }
  // keep this vehicle's footage under this many GB: the oldest unprotected
  // recordings beyond it move to the Recycle Bin at the run
  if (input.maxGB !== undefined) {
    if (input.maxGB === null || input.maxGB === '') out.maxGB = null;
    else {
      const n = Number(input.maxGB);
      if (!Number.isFinite(n) || n < 1 || n > 1_000_000) throw Object.assign(new Error('Keep the footage under 1 GB or more, or leave it empty for no limit.'), { status: 400 });
      out.maxGB = Math.round(n * 10) / 10;
    }
  }
  if (input.binDays !== undefined) {
    if (input.binDays === null || input.binDays === '') out.binDays = null;
    else {
      const n = Number(input.binDays);
      if (!Number.isInteger(n) || n < 1 || n > 365) throw Object.assign(new Error('Empty the Recycle Bin after 1 to 365 days, or leave empty to keep it until you empty it.'), { status: 400 });
      out.binDays = n;
    }
  }
  for (const c of CATEGORIES) {
    const v = input.keepDays?.[c];
    if (v === undefined) continue;
    if (v === null || v === '') out.keepDays[c] = null;
    else {
      const n = Number(v);
      if (!Number.isInteger(n) || n < 1 || n > 3650) throw Object.assign(new Error(`${c}: keep between 1 and 3650 days, or leave empty to keep forever.`), { status: 400 });
      out.keepDays[c] = n;
    }
  }
  return out;
}

/** 'YYYY-MM-DD' of `now` in a time zone. */
function dayInZone(now, timeZone) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now);
  const get = (t) => parts.find((p) => p.type === t).value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}

function daysBetween(a, b) {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000);
}

/** Recordings a policy would move: older than keepDays by their capture day. */
function selectExpired(recordings, policy, { now = new Date(), timeZone = 'UTC' } = {}) {
  const today = dayInZone(now, timeZone);
  return recordings.filter((r) => {
    const keep = policy.keepDays[r.category];
    if (!keep || r.protected || !r.day) return false;
    return daysBetween(r.day, today) >= keep;
  });
}

class Policies {
  constructor({ db, vehicles, inventory, bin, log }) {
    Object.assign(this, { db, vehicles, inventory, bin, log });
  }

  get(vehicleId) {
    return { ...defaultPolicy(), ...(this.db.get(`policy:${vehicleId}`) || {}) };
  }

  set(vehicleId, input) {
    if (!this.vehicles.get(vehicleId)) throw Object.assign(new Error('No such vehicle.'), { status: 404 });
    const next = normalizePolicy(input, this.get(vehicleId));
    this.db.set(`policy:${vehicleId}`, next);
    return next;
  }

  preview(vehicleId) {
    const vehicle = this.vehicles.get(vehicleId);
    const inv = this.inventory.get(vehicleId);
    if (!vehicle || !inv?.recordings) return { recordings: 0, bytes: 0, byCategory: {} };
    const policy = this.get(vehicleId);
    const hit = selectExpired(inv.recordings, policy, { timeZone: vehicle.timezone });
    // over the size limit: the oldest of the rest, until under it
    let overLimit = 0;
    if (policy.maxGB) {
      const limit = policy.maxGB * 1024 ** 3;
      const chosen = new Set(hit.map((r) => r.id));
      let total = inv.recordings.reduce((n, r) => n + (r.bytes || 0), 0) - hit.reduce((n, r) => n + (r.bytes || 0), 0);
      const oldest = inv.recordings.filter((r) => !chosen.has(r.id) && !r.protected).sort((a, b) => String(a.startKey).localeCompare(String(b.startKey)));
      for (const r of oldest) {
        if (total <= limit) break;
        hit.push(r);
        total -= r.bytes || 0;
        overLimit++;
      }
    }
    const byCategory = {};
    for (const r of hit) {
      byCategory[r.category] = byCategory[r.category] || { recordings: 0, bytes: 0 };
      byCategory[r.category].recordings++;
      byCategory[r.category].bytes += r.bytes;
    }
    return { recordings: hit.length, bytes: hit.reduce((n, r) => n + r.bytes, 0), byCategory, overLimit, ids: hit.map((r) => r.id) };
  }

  /**
   * Run the vehicle's policy now. `expect` (optional) is the policy the person
   * confirmed: when the saved one has changed since (another tab or person
   * saved it), nothing runs, so a confirmation never stands for a different
   * rule, least of all one that empties the Recycle Bin for good.
   */
  async run(vehicleId, { expect } = {}) {
    const unchanged = () => !expect || ruleKey(this.get(vehicleId)) === ruleKey(expect);
    const changed = () => Object.assign(new Error('The cleanup rule changed after you confirmed. Check it and run it again.'), { status: 409 });
    if (!unchanged()) throw changed();
    await this.inventory.scan(vehicleId);
    if (!unchanged()) throw changed();
    const { ids } = this.preview(vehicleId);
    const result = ids.length ? await this.bin.trash(vehicleId, ids, { reason: 'policy' }) : { moved: [], skipped: [], bytes: 0 };
    const policy = this.get(vehicleId);
    // checked again right before anything is deleted for good
    if (!unchanged()) throw changed();
    const emptied = policy.binDays ? await this.emptyOld(vehicleId, policy.binDays) : null;
    this.db.set(`policy:${vehicleId}`, {
      ...policy, lastRunAt: Date.now(),
      lastResult: { moved: result.moved.length, skipped: result.skipped.length, bytes: result.bytes, ...(emptied ? { emptied: emptied.deleted, freed: emptied.bytes } : {}) }
    });
    return result;
  }

  /** Delete for good what has been in the vehicle's Recycle Bin longer than `days`. */
  async emptyOld(vehicleId, days, now = Date.now()) {
    const before = now - days * 86400000;
    let deleted = 0;
    let bytes = 0;
    for (const item of this.db.binItems(vehicleId)) {
      if (!(item.trashedAt < before)) continue;
      try {
        bytes += (await this.bin.deleteForever(item.id)).bytes || 0;
        deleted++;
      } catch (err) {
        this.log.warn(`Recycle Bin: could not empty ${item.label}: ${err.message}`);
      }
    }
    if (deleted) this.log.info(`Recycle Bin of ${vehicleId}: ${deleted} item(s) older than ${days} days deleted`);
    return { deleted, bytes };
  }

  /** Called every minute: run policies whose time has come. */
  async tick(now = new Date()) {
    for (const v of this.vehicles.list()) {
      const p = this.get(v.id);
      if (!p.enabled) continue;
      const hhmm = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
      const ranToday = p.lastRunAt && new Date(p.lastRunAt).toDateString() === now.toDateString();
      if (hhmm >= p.runAt && !ranToday) {
        try {
          await this.run(v.id);
        } catch (err) {
          this.log.warn(`Policy for ${v.name} did not run: ${err.message}`);
          this.db.set(`policy:${v.id}`, { ...p, lastRunAt: Date.now(), lastResult: { error: err.message } });
        }
      }
    }
  }
}

module.exports = { Policies, selectExpired, normalizePolicy, defaultPolicy, dayInZone, ruleKey, CATEGORIES };
