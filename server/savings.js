'use strict';

// Space saved by conversions, per vehicle and for good: each converter job's
// saved bytes and converted clips, added to its vehicle's total as the job
// runs. A job counts once however often its snapshot comes in (only what it
// adds since the last one is added), and the totals stay when the job is
// cleared from Jobs or the converter forgets it.

const KEY = 'savings';

function createSavings({ db }) {
  const load = () => {
    const s = db.get(KEY, null);
    return s && typeof s === 'object' ? { vehicles: s.vehicles || {}, jobs: s.jobs || {} } : { vehicles: {}, jobs: {} };
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
    db.set(KEY, s);
    return true;
  }

  return { record, forVehicle, forget, reset };
}

module.exports = { createSavings };
