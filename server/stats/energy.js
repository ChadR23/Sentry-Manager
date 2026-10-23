'use strict';

// Energy in Wh, integrated from the power samples, per day (in the server's
// time zone) and per conversion job, and what it cost at the price of each
// moment (a time-of-use plan makes the night cheaper than the evening).
// Only time that was sampled counts (a gap longer than a few intervals, when
// nobody watched and nothing converted, is not guessed), so "today" means
// "measured today".
//
// A job's record also keeps where the job stood when its energy began to be
// measured (its baseline: clips converted, bytes saved and the Wh counted
// before then), so clips and space per kWh count only what was converted
// while the energy was measured. A job that ran before measuring began (or
// before a restart into a version that measures) would otherwise divide all
// of its clips by a few minutes of energy. Time the job's energy is not
// counted (no power reading, a gap, a benchmark in between) moves the
// baseline on by what the job converted meanwhile, for the same reason.

const DAYS_KEPT = 62;
const JOBS_KEPT = 200;

function dayKey(t) {
  const d = new Date(t);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

const r3 = (n) => Math.round(n * 1000) / 1000;
// a few seconds of a few watts cost a millionth; the screens round for display
const money = (n) => (n === null || n === undefined ? null : Math.round(n * 1e6) / 1e6);
const finite = (n) => typeof n === 'number' && Number.isFinite(n) && n >= 0;

/** A saved or reported baseline ({ clips, savedB, wh }), or null. */
function cleanBase(base, maxWh = Infinity) {
  if (!base || typeof base !== 'object') return null;
  const { clips, savedB, wh } = base;
  if (!Number.isSafeInteger(clips) || clips < 0 || typeof savedB !== 'number' || !Number.isFinite(savedB) || !finite(wh) || wh > maxWh) return null;
  return { clips, savedB, wh };
}

class Energy {
  /**
   * `progressOf(jobId)` says where a job stands now ({ clips, savedB }, or
   * null when it is not known): asked at each sample while the job is
   * counted.
   */
  constructor({ intervalMs, progressOf = null }) {
    this.maxGapMs = Math.max(3 * intervalMs, 10000);
    this.last = null; // { t, w }
    // no prototype: a job id is data and must never reach Object.prototype
    this.days = Object.create(null); // 'YYYY-MM-DD' -> Wh
    this.costs = Object.create(null); // 'YYYY-MM-DD' -> cost of the priced part of that day
    this.jobs = Object.create(null); // jobId -> { wh, seconds, at, cost, base }
    this.job = null;
    this.progressOf = typeof progressOf === 'function' ? progressOf : null;
    // where each job stood at its last sample (not saved), and whether the
    // job was just marked again (the time in between was not its own)
    this.seen = Object.create(null);
    this.marked = false;
  }

  /** The job's clips and saved bytes now, or null. */
  progress(jobId) {
    if (!this.progressOf) return null;
    try {
      const p = this.progressOf(jobId);
      return p ? cleanBase({ clips: p.clips, savedB: p.savedB, wh: 0 }) : null;
    } catch {
      return null;
    }
  }

  /**
   * One power sample (W or null) at time t, and the price per kWh in force
   * then (null when no price is set: the energy counts, the cost does not).
   */
  add(t, watts, pricePerKwh = null) {
    const w = finite(watts) ? watts : null;
    const prev = this.last;
    this.last = w === null ? null : { t, w };
    const ms = prev && w !== null ? t - prev.t : NaN;
    const counted = ms > 0 && ms <= this.maxGapMs;
    // where the job stands now, and what it converted since its last sample
    // while its energy was not counted
    const now = this.job !== null ? this.progress(this.job) : null;
    if (this.job !== null) this.follow(now, !counted || this.marked);
    this.marked = false;
    if (!counted) return;
    const wh = ((prev.w + w) / 2) * (ms / 3600000);
    const cost = finite(pricePerKwh) ? (wh / 1000) * pricePerKwh : null;
    const key = dayKey(t);
    this.days[key] = (this.days[key] || 0) + wh;
    if (cost !== null) this.costs[key] = (this.costs[key] || 0) + cost;
    if (this.job !== null) {
      const j = this.jobs[this.job] || (this.jobs[this.job] = { wh: 0, seconds: 0, at: t, cost: null, base: null });
      // measuring starts for this job (or for one saved before baselines
      // were kept): from here on its clips count against its energy
      if (!j.base && now) j.base = { clips: now.clips, savedB: now.savedB, wh: j.wh };
      j.wh += wh;
      j.seconds += ms / 1000;
      j.at = t;
      if (cost !== null) j.cost = (j.cost || 0) + cost;
    }
  }

  /**
   * The current job's progress at a sample (`now`); `skipped`: the time
   * since its last sample was not counted, so what it converted meanwhile
   * moves its baseline on (it is not divided by energy that was not
   * measured).
   */
  follow(now, skipped) {
    const j = this.jobs[this.job];
    const seen = this.seen[this.job];
    if (skipped && j?.base && seen && now) {
      j.base = { clips: Math.max(0, j.base.clips + now.clips - seen.clips), savedB: j.base.savedB + now.savedB - seen.savedB, wh: j.base.wh };
    }
    if (now) this.seen[this.job] = { clips: now.clips, savedB: now.savedB };
  }

  markJob(jobId) {
    const job = jobId === null || jobId === undefined ? null : String(jobId);
    if (job !== this.job) this.marked = true;
    this.job = job;
  }

  /** A job needs power samples to keep coming. */
  active() {
    return this.job !== null;
  }

  summary(t) {
    const today = dayKey(t);
    // the 7 calendar days ending today (counted by date, so a 23- or 25-hour
    // day around a clock change is still one day)
    const d = new Date(t);
    let week = 0;
    let weekCost = null;
    for (let i = 0; i < 7; i++) {
      const key = dayKey(new Date(d.getFullYear(), d.getMonth(), d.getDate() - i, 12).getTime());
      week += this.days[key] || 0;
      if (this.costs[key] !== undefined) weekCost = (weekCost || 0) + this.costs[key];
    }
    // fromEntries defines own properties, so even a job called "__proto__" is just a key
    const byJob = Object.fromEntries(Object.entries(this.jobs).map(([id, j]) => [id, {
      wh: r3(j.wh), avgW: j.seconds > 0 ? Math.round((j.wh * 3600 / j.seconds) * 10) / 10 : null, seconds: Math.round(j.seconds), cost: money(j.cost),
      base: j.base ? { clips: j.base.clips, savedB: j.base.savedB, wh: r3(j.base.wh) } : null
    }]));
    return {
      todayWh: r3(this.days[today] || 0), weekWh: r3(week),
      todayCost: money(this.costs[today] ?? null), weekCost: money(weekCost), byJob
    };
  }

  trim() {
    for (const map of [this.days, this.costs]) {
      const keys = Object.keys(map).sort();
      for (const k of keys.slice(0, Math.max(0, keys.length - DAYS_KEPT))) delete map[k];
    }
    const jobs = Object.entries(this.jobs).sort((a, b) => a[1].at - b[1].at);
    for (const [id] of jobs.slice(0, Math.max(0, jobs.length - JOBS_KEPT))) if (id !== this.job) delete this.jobs[id];
    for (const id of Object.keys(this.seen)) if (!this.jobs[id] && id !== this.job) delete this.seen[id];
  }

  toJSON() {
    this.trim();
    return { days: this.days, costs: this.costs, jobs: this.jobs };
  }

  load(data) {
    if (!data || typeof data !== 'object') return;
    const perDay = (src) => {
      const out = Object.create(null);
      for (const [k, v] of Object.entries(src && typeof src === 'object' ? src : {})) if (/^\d{4}-\d{2}-\d{2}$/.test(k) && finite(v)) out[k] = v;
      return out;
    };
    const jobs = Object.create(null);
    for (const [k, j] of Object.entries(data.jobs && typeof data.jobs === 'object' ? data.jobs : {})) {
      if (k.length <= 200 && j && finite(j.wh) && finite(j.seconds)) {
        // a record saved without a baseline gets one when it is counted next
        jobs[k] = { wh: j.wh, seconds: j.seconds, at: Number(j.at) || 0, cost: finite(j.cost) ? j.cost : null, base: cleanBase(j.base, j.wh) };
      }
    }
    this.days = perDay(data.days);
    this.costs = perDay(data.costs);
    this.jobs = jobs;
    this.trim();
  }
}

module.exports = { Energy, dayKey };
