'use strict';

// Space saved by conversions, per vehicle and for good: each converter job's
// saved bytes and converted clips, added to its vehicle's total as the job
// runs. A job counts once however often its snapshot comes in (only what it
// adds since the last one is added), and the totals stay when the job is
// cleared from Jobs or the converter forgets it.
//
// The same is kept by month (months: { vehicle: { 'YYYY-MM': { bytes, clips } } }),
// what each job adds going to the month it is added in. Totals from before
// months were kept are put in the month their job finished, once
// (backfill, from the job history).

const KEY = 'savings';

function createSavings({ db }) {
  const load = () => {
    const s = db.get(KEY, null);
    return s && typeof s === 'object'
      ? { vehicles: s.vehicles || {}, jobs: s.jobs || {}, months: s.months || {}, monthsSince: s.monthsSince || null }
      : { vehicles: {}, jobs: {}, months: {}, monthsSince: null };
  };
  const monthOf = (t) => { const d = new Date(t); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`; };
  const addMonth = (s, vehicleId, month, bytes, clips) => {
    const v = (s.months[vehicleId] ||= {});
    const m = (v[month] ||= { bytes: 0, clips: 0 });
    m.bytes += Math.max(0, bytes);
    m.clips += Math.max(0, clips);
  };

  /** A converter job's totals so far: `bytes` saved and `clips` converted. */
  function record(jobId, vehicleId, { bytes, clips }) {
    if (!jobId || !vehicleId) return false;
    bytes = Number.isFinite(bytes) ? Math.max(0, Math.round(bytes)) : 0;
    clips = Number.isSafeInteger(clips) ? Math.max(0, clips) : 0;
    const s = load();
    const seen = s.jobs[jobId] || { vehicleId, bytes: 0, clips: 0 };
    const addB = bytes - seen.bytes;
    const addC = clips - seen.clips;
    if (addB <= 0 && addC <= 0) return false;
    const v = s.vehicles[seen.vehicleId] || { bytes: 0, clips: 0 };
    v.bytes += Math.max(0, addB);
    v.clips += Math.max(0, addC);
    s.vehicles[seen.vehicleId] = v;
    addMonth(s, seen.vehicleId, monthOf(Date.now()), addB, addC);
    s.jobs[jobId] = { vehicleId: seen.vehicleId, bytes: Math.max(bytes, seen.bytes), clips: Math.max(clips, seen.clips) };
    db.set(KEY, s);
    return true;
  }

  /** One vehicle's total: { bytes, clips }. */
  function forVehicle(vehicleId) {
    const v = load().vehicles[vehicleId];
    return { bytes: v?.bytes || 0, clips: v?.clips || 0 };
  }

  /** A removed vehicle's total goes with it. */
  function forget(vehicleId) {
    const s = load();
    if (!s.vehicles[vehicleId]) return;
    delete s.vehicles[vehicleId];
    delete s.months[vehicleId];
    for (const [id, j] of Object.entries(s.jobs)) if (j.vehicleId === vehicleId) delete s.jobs[id];
    db.set(KEY, s);
  }

  /**
   * Start a vehicle's total over (its footage was deleted, say). The jobs it
   * has seen stay remembered, so a conversion still running only adds what
   * it saves from now on.
   */
  function reset(vehicleId) {
    const s = load();
    const v = s.vehicles[vehicleId];
    if (!v || (!v.bytes && !v.clips)) return false;
    s.vehicles[vehicleId] = { bytes: 0, clips: 0 };
    delete s.months[vehicleId];
    db.set(KEY, s);
    return true;
  }

  /**
   * Once: the jobs counted before months were kept go to the month they
   * finished in (`monthOfJob(jobId)`, from the job history; else this month).
   */
  function backfill(monthOfJob) {
    const s = load();
    if (s.monthsSince) return false;
    for (const [id, j] of Object.entries(s.jobs)) {
      if (!s.vehicles[j.vehicleId]) continue;
      addMonth(s, j.vehicleId, monthOfJob(id) || monthOf(Date.now()), j.bytes || 0, j.clips || 0);
    }
    s.monthsSince = Date.now();
    db.set(KEY, s);
    return true;
  }

  /** One vehicle's savings by month, oldest first: [{ month: 'YYYY-MM', bytes, clips }] (the last `count` months, empty ones too). */
  function byMonth(vehicleId, count = 12, now = new Date()) {
    const m = load().months[vehicleId] || {};
    const out = [];
    for (let i = count - 1; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      const key = monthOf(d.getTime());
      out.push({ month: key, bytes: m[key]?.bytes || 0, clips: m[key]?.clips || 0 });
    }
    return out;
  }

  return { record, forVehicle, forget, reset, backfill, byMonth };
}

module.exports = { createSavings };
