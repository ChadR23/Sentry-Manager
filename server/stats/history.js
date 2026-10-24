'use strict';

// History for the graphs: every sample of the last 15 minutes, and 1-minute
// averages of the last 24 hours. Both are kept in memory and saved with the
// energy totals (see index.js), so a restart does not empty the graphs.

const { round } = require('./util');

const SERIES = ['cpu', 'memory', 'gpuBusy', 'gpuVideo', 'powerW', 'rxBps', 'txBps', 'tempMax'];
const DIGITS = { cpu: 1, memory: 1, gpuBusy: 0, gpuVideo: 0, powerW: 1, rxBps: 0, txBps: 0, tempMax: 1 };
const RECENT_MS = 15 * 60 * 1000;
const DAY_MS = 24 * 3600 * 1000;
const MINUTE = 60000;
const SPARK_POINTS = 90;

const clean = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

class History {
  constructor({ intervalMs }) {
    this.intervalMs = intervalMs;
    this.recent = []; // [t, ...values]
    this.minutes = []; // [minuteStart, ...averages]
    this.open = null; // the minute being collected: { t, sum, n }
  }

  /** Add one sample (values in SERIES order). */
  add(t, values) {
    const row = [t, ...SERIES.map((name, i) => round(clean(values[i]), DIGITS[name]))];
    this.recent.push(row);
    const cut = t - RECENT_MS - this.intervalMs;
    let drop = 0;
    while (drop < this.recent.length && this.recent[drop][0] < cut) drop++;
    if (drop) this.recent.splice(0, drop);
    if (this.recent.length > 2000) this.recent.splice(0, this.recent.length - 2000);

    const minute = Math.floor(t / MINUTE) * MINUTE;
    if (this.open && this.open.t !== minute) this.closeMinute();
    if (!this.open) this.open = { t: minute, sum: SERIES.map(() => 0), n: SERIES.map(() => 0) };
    row.slice(1).forEach((v, i) => {
      if (v !== null) {
        this.open.sum[i] += v;
        this.open.n[i]++;
      }
    });
  }

  closeMinute() {
    const m = this.open;
    this.open = null;
    if (!m) return;
    const avg = SERIES.map((name, i) => (m.n[i] ? round(m.sum[i] / m.n[i], DIGITS[name]) : null));
    if (avg.some((v) => v !== null)) {
      if (this.minutes.length && this.minutes[this.minutes.length - 1][0] >= m.t) this.minutes = this.minutes.filter((r) => r[0] < m.t);
      this.minutes.push([m.t, ...avg]);
    }
    const cut = m.t - DAY_MS;
    let drop = 0;
    while (drop < this.minutes.length && this.minutes[drop][0] <= cut) drop++;
    if (drop) this.minutes.splice(0, drop);
  }

  /** Rows of a range, oldest first: 2 s samples for '15m', minute averages for '24h'. */
  rows(range, t) {
    if (range === '24h') {
      const rows = this.minutes.filter((r) => r[0] > t - DAY_MS);
      if (this.open) {
        const m = this.open;
        rows.push([m.t, ...SERIES.map((name, i) => (m.n[i] ? round(m.sum[i] / m.n[i], DIGITS[name]) : null))]);
      }
      return rows;
    }
    return this.recent.filter((r) => r[0] > t - RECENT_MS);
  }

  /**
   * { step, start, series } on a regular grid ending now: one slot per step,
   * null where nothing was sampled (nobody watching, nothing converting).
   * Slot i is the time start + i * step.
   */
  range(range, t) {
    const day = range === '24h';
    const step = day ? MINUTE : this.intervalMs;
    const span = day ? DAY_MS : RECENT_MS;
    const n = Math.max(1, Math.round(span / step));
    const end = day ? Math.floor(t / MINUTE) * MINUTE : t;
    const start = end - (n - 1) * step;
    const series = Object.fromEntries(SERIES.map((name) => [name, new Array(n).fill(null)]));
    for (const row of this.rows(day ? '24h' : '15m', t)) {
      const slot = Math.round((row[0] - start) / step);
      if (slot < 0 || slot >= n) continue;
      SERIES.forEach((name, i) => {
        if (row[i + 1] !== null) series[name][slot] = row[i + 1];
      });
    }
    return { step, start, series };
  }

  /** The tiles' sparklines: the last 15 min, averaged down to at most 90 points, no gaps. */
  sparks(t) {
    const rows = this.rows('15m', t);
    const pick = (i, digits) => {
      const vals = rows.map((r) => r[i + 1]).filter((v) => v !== null);
      if (vals.length <= SPARK_POINTS) return vals;
      const size = vals.length / SPARK_POINTS;
      const out = [];
      for (let k = 0; k < SPARK_POINTS; k++) {
        const part = vals.slice(Math.floor(k * size), Math.floor((k + 1) * size));
        out.push(round(part.reduce((a, b) => a + b, 0) / part.length, digits));
      }
      return out;
    };
    return {
      cpu: pick(SERIES.indexOf('cpu'), 1),
      gpuVideo: pick(SERIES.indexOf('gpuVideo'), 0),
      gpuBusy: pick(SERIES.indexOf('gpuBusy'), 0),
      rxBps: pick(SERIES.indexOf('rxBps'), 0)
    };
  }

  /** text/csv of a range: an ISO time column, then the series; empty cells for no data. */
  csv(range, t) {
    const lines = [['time', ...SERIES].join(',')];
    for (const row of this.rows(range === '24h' ? '24h' : '15m', t)) {
      lines.push([new Date(row[0]).toISOString(), ...row.slice(1).map((v) => (v === null ? '' : String(v)))].join(','));
    }
    return `${lines.join('\n')}\n`;
  }

  toJSON() {
    return { series: SERIES, recent: this.recent, minutes: this.minutes, open: this.open };
  }

  /** Take back what was saved; anything malformed or too old is skipped. */
  load(data, t) {
    if (!data || !Array.isArray(data.series)) return;
    // map saved columns by name, so a series added later loads as empty
    const idx = SERIES.map((name) => data.series.indexOf(name));
    const take = (row) => {
      if (!Array.isArray(row) || !Number.isFinite(row[0])) return null;
      return [row[0], ...idx.map((i, k) => (i < 0 ? null : round(clean(row[i + 1]), DIGITS[SERIES[k]])))];
    };
    const ordered = (rows, from) => (Array.isArray(rows) ? rows : []).slice(-5000).map(take)
      .filter((r) => r && r[0] > from && r[0] <= t + MINUTE).sort((a, b) => a[0] - b[0]);
    this.recent = ordered(data.recent, t - RECENT_MS);
    this.minutes = ordered(data.minutes, t - DAY_MS);
    const o = data.open;
    if (o && Number.isFinite(o.t) && Array.isArray(o.sum) && Array.isArray(o.n) && o.t > t - DAY_MS && o.t <= t) {
      const at = (arr, i) => (i < 0 ? 0 : Number(arr[i]) || 0);
      this.open = { t: o.t, sum: idx.map((i) => at(o.sum, i)), n: idx.map((i) => at(o.n, i)) };
      if (Math.floor(t / MINUTE) * MINUTE !== o.t) this.closeMinute();
    }
  }
}

module.exports = { History, SERIES };
