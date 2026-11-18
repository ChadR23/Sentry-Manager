//! history.js: every sample of the last 15 minutes, 1-minute averages of the
//! last 24 hours, the sparklines and the CSV, saved in stats-history.json.

use crate::ops::js::num;
use serde_json::{json, Map, Value};

pub const SERIES: [&str; 8] = ["cpu", "memory", "gpuBusy", "gpuVideo", "powerW", "rxBps", "txBps", "tempMax"];
const DIGITS: [i32; 8] = [1, 1, 0, 0, 1, 0, 0, 1];
const RECENT_MS: i64 = 15 * 60 * 1000;
const DAY_MS: i64 = 24 * 3600 * 1000;
const MINUTE: i64 = 60_000;
const SPARK_POINTS: usize = 90;

/// Math.round
pub fn js_round(x: f64) -> f64 {
    (x + 0.5).floor()
}

/// util.js round(n, digits)
pub fn round(n: Option<f64>, digits: i32) -> Option<f64> {
    let n = n.filter(|x| x.is_finite())?;
    let f = 10f64.powi(digits);
    Some(js_round(n * f) / f)
}

type Row = Vec<Option<f64>>; // [t, ...values]

#[derive(Clone, Debug)]
struct Open {
    t: i64,
    sum: Vec<f64>,
    n: Vec<f64>,
}

/// history.js: every sample of the last 15 minutes, 1-minute averages of the last 24 hours.
#[derive(Clone, Debug)]
pub struct History {
    interval_ms: i64,
    recent: Vec<Row>,
    minutes: Vec<Row>,
    open: Option<Open>,
}

fn t_of(r: &Row) -> i64 {
    r[0].unwrap_or(0.0) as i64
}

impl History {
    pub fn new(interval_ms: i64) -> History {
        History { interval_ms, recent: Vec::new(), minutes: Vec::new(), open: None }
    }

    pub fn add(&mut self, t: i64, values: &[Option<f64>]) {
        let mut row: Row = vec![Some(t as f64)];
        for (i, _) in SERIES.iter().enumerate() {
            row.push(round(values.get(i).copied().flatten(), DIGITS[i]));
        }
        self.recent.push(row.clone());
        let cut = t - RECENT_MS - self.interval_ms;
        let drop = self.recent.iter().take_while(|r| t_of(r) < cut).count();
        self.recent.drain(..drop);
        if self.recent.len() > 2000 {
            let n = self.recent.len() - 2000;
            self.recent.drain(..n);
        }
        let minute = t.div_euclid(MINUTE) * MINUTE;
        if self.open.as_ref().is_some_and(|o| o.t != minute) {
            self.close_minute();
        }
        let open = self.open.get_or_insert_with(|| Open { t: minute, sum: vec![0.0; SERIES.len()], n: vec![0.0; SERIES.len()] });
        for (i, v) in row[1..].iter().enumerate() {
            if let Some(v) = v {
                open.sum[i] += v;
                open.n[i] += 1.0;
            }
        }
    }

    fn averages(m: &Open) -> Vec<Option<f64>> {
        (0..SERIES.len()).map(|i| if m.n[i] != 0.0 { round(Some(m.sum[i] / m.n[i]), DIGITS[i]) } else { None }).collect()
    }

    fn close_minute(&mut self) {
        let Some(m) = self.open.take() else { return };
        let avg = Self::averages(&m);
        if avg.iter().any(Option::is_some) {
            if self.minutes.last().is_some_and(|r| t_of(r) >= m.t) {
                self.minutes.retain(|r| t_of(r) < m.t);
            }
            let mut row = vec![Some(m.t as f64)];
            row.extend(avg);
            self.minutes.push(row);
        }
        let cut = m.t - DAY_MS;
        let drop = self.minutes.iter().take_while(|r| t_of(r) <= cut).count();
        self.minutes.drain(..drop);
    }

    fn rows(&self, day: bool, t: i64) -> Vec<Row> {
        if day {
            let mut rows: Vec<Row> = self.minutes.iter().filter(|r| t_of(r) > t - DAY_MS).cloned().collect();
            if let Some(m) = &self.open {
                let mut row = vec![Some(m.t as f64)];
                row.extend(Self::averages(m));
                rows.push(row);
            }
            return rows;
        }
        self.recent.iter().filter(|r| t_of(r) > t - RECENT_MS).cloned().collect()
    }

    /// { step, start, series } on a regular grid ending now.
    pub fn range(&self, day: bool, t: i64) -> Value {
        let step = if day { MINUTE } else { self.interval_ms };
        let span = if day { DAY_MS } else { RECENT_MS };
        let n = (js_round(span as f64 / step as f64) as i64).max(1) as usize;
        let end = if day { t.div_euclid(MINUTE) * MINUTE } else { t };
        let start = end - (n as i64 - 1) * step;
        let mut series: Vec<Vec<Value>> = vec![vec![Value::Null; n]; SERIES.len()];
        for row in self.rows(day, t) {
            let slot = js_round((t_of(&row) - start) as f64 / step as f64);
            if slot < 0.0 || slot >= n as f64 {
                continue;
            }
            for i in 0..SERIES.len() {
                if let Some(v) = row[i + 1] {
                    series[i][slot as usize] = num(v);
                }
            }
        }
        let mut m = Map::new();
        for (i, name) in SERIES.iter().enumerate() {
            m.insert(name.to_string(), Value::Array(std::mem::take(&mut series[i])));
        }
        json!({ "step": step, "start": start, "series": m })
    }

    /// The tiles' sparklines: the last 15 min, averaged down to at most 90 points.
    pub fn sparks(&self, t: i64) -> Value {
        let rows = self.rows(false, t);
        let pick = |name: &str, digits: i32| -> Value {
            let i = SERIES.iter().position(|s| *s == name).unwrap();
            let vals: Vec<f64> = rows.iter().filter_map(|r| r[i + 1]).collect();
            if vals.len() <= SPARK_POINTS {
                return json!(vals.iter().map(|v| num(*v)).collect::<Vec<_>>());
            }
            let size = vals.len() as f64 / SPARK_POINTS as f64;
            let out: Vec<Value> = (0..SPARK_POINTS)
                .map(|k| {
                    let part = &vals[(k as f64 * size).floor() as usize..((k + 1) as f64 * size).floor() as usize];
                    round(Some(part.iter().sum::<f64>() / part.len() as f64), digits).map_or(Value::Null, num)
                })
                .collect();
            json!(out)
        };
        json!({ "cpu": pick("cpu", 1), "gpuVideo": pick("gpuVideo", 0), "gpuBusy": pick("gpuBusy", 0), "rxBps": pick("rxBps", 0), "txBps": pick("txBps", 0) })
    }

    /// text/csv of a range: an ISO time column, then the series.
    pub fn csv(&self, day: bool, t: i64) -> String {
        let mut lines = vec![std::iter::once("time").chain(SERIES).collect::<Vec<_>>().join(",")];
        for row in self.rows(day, t) {
            let mut cells = vec![crate::ops::js::iso(t_of(&row))];
            cells.extend(row[1..].iter().map(|v| v.map_or(String::new(), crate::ops::js::num_text)));
            lines.push(cells.join(","));
        }
        format!("{}\n", lines.join("\n"))
    }

    pub fn to_json(&self) -> Value {
        let rows = |rs: &[Row]| json!(rs.iter().map(|r| r.iter().map(|v| v.map_or(Value::Null, num)).collect::<Vec<_>>()).collect::<Vec<_>>());
        json!({
            "series": SERIES, "recent": rows(&self.recent), "minutes": rows(&self.minutes),
            "open": self.open.as_ref().map(|o| json!({ "t": o.t, "sum": o.sum.iter().map(|x| num(*x)).collect::<Vec<_>>(), "n": o.n.iter().map(|x| num(*x)).collect::<Vec<_>>() }))
        })
    }

    /// Takes back what was saved; anything malformed or too old is skipped.
    pub fn load(&mut self, data: &Value, t: i64) {
        let Some(names) = data["series"].as_array() else { return };
        let idx: Vec<Option<usize>> = SERIES.iter().map(|n| names.iter().position(|x| x == n)).collect();
        let take = |row: &Value| -> Option<Row> {
            let a = row.as_array()?;
            let t0 = a.first()?.as_f64().filter(|x| x.is_finite())?;
            let mut r = vec![Some(t0)];
            for (k, i) in idx.iter().enumerate() {
                r.push(i.and_then(|i| a.get(i + 1)).and_then(Value::as_f64).filter(|x| x.is_finite()).and_then(|v| round(Some(v), DIGITS[k])));
            }
            Some(r)
        };
        let ordered = |rows: &Value, from: i64| -> Vec<Row> {
            let list = rows.as_array().cloned().unwrap_or_default();
            let skip = list.len().saturating_sub(5000);
            let mut out: Vec<Row> = list[skip..].iter().filter_map(take).filter(|r| t_of(r) > from && (r[0].unwrap()) <= (t + MINUTE) as f64).collect();
            out.sort_by(|a, b| a[0].partial_cmp(&b[0]).unwrap());
            out
        };
        self.recent = ordered(&data["recent"], t - RECENT_MS);
        self.minutes = ordered(&data["minutes"], t - DAY_MS);
        let o = &data["open"];
        if let (Some(ot), Some(sum), Some(n)) = (o["t"].as_f64(), o["sum"].as_array(), o["n"].as_array()) {
            let ot = ot as i64;
            if ot > t - DAY_MS && ot <= t {
                let at = |arr: &Vec<Value>, i: Option<usize>| i.and_then(|i| arr.get(i)).map(crate::ops::js::number).filter(|x| x.is_finite() && *x != 0.0).unwrap_or(0.0);
                self.open = Some(Open { t: ot, sum: idx.iter().map(|i| at(sum, *i)).collect(), n: idx.iter().map(|i| at(n, *i)).collect() });
                if t.div_euclid(MINUTE) * MINUTE != ot {
                    self.close_minute();
                }
            }
        }
    }
}

/// The CSV's file name, as Node's Content-Disposition gives it.
pub fn csv_name(range: &str) -> String {
    format!("sentry-six-manager-stats-{range}.csv")
}

#[cfg(test)]
mod tests {
    use super::*;

    // test/statsHistory.test.js (the grid, minute averages, CSV and a restart)
    #[test]
    fn history_grid_minutes_csv_and_reload() {
        let mut h = History::new(2000);
        let t0 = 1_763_200_000_000i64 - (1_763_200_000_000i64 % MINUTE);
        for k in 0..40 {
            h.add(t0 + k * 2000, &[Some(10.0 + k as f64), Some(50.04), None, None, Some(12.25), Some(1000.4), Some(0.0), None]);
        }
        let now = t0 + 39 * 2000;
        let r = h.range(false, now);
        assert_eq!(r["step"], 2000);
        let cpu = r["series"]["cpu"].as_array().unwrap();
        assert_eq!(cpu.len(), 450);
        assert_eq!(cpu[449], 49);
        assert_eq!(cpu[449 - 39], 10);
        assert_eq!(cpu[0], Value::Null);
        assert_eq!(r["series"]["memory"][449], 50.0);
        let day = h.range(true, now);
        assert_eq!(day["series"]["cpu"].as_array().unwrap().len(), 1440);
        // the first minute closed (30 samples: 10..39), the second open (40..49)
        assert_eq!(day["series"]["cpu"][1439], 44.5);
        assert_eq!(day["series"]["cpu"][1438], 24.5);
        let csv = h.csv(false, now);
        let mut lines = csv.lines();
        assert_eq!(lines.next(), Some("time,cpu,memory,gpuBusy,gpuVideo,powerW,rxBps,txBps,tempMax"));
        assert_eq!(lines.next().unwrap(), format!("{},10,50,,,12.3,1000,0,", crate::ops::js::iso(t0)));
        // a restart takes it back
        let saved = h.to_json();
        let mut again = History::new(2000);
        again.load(&saved, now);
        assert_eq!(again.range(false, now), r);
        assert_eq!(again.range(true, now), day);
        let s = h.sparks(now);
        assert_eq!(s["cpu"].as_array().unwrap().len(), 40);
    }
}
