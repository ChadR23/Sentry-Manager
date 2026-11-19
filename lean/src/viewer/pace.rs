//! How many clips background reading (the speed index) may read at once
//! (a port of server/backgroundPace.js).
//!
//! It starts at one and adds one at a time while the server keeps up; it
//! halves when the server starts to stall or reads get much slower than they
//! were, and it stops for a moment on a long stall. A step up that does not
//! read more clips a minute than before is taken back. While someone plays
//! footage in the Viewer it reads one clip at a time, until a while after
//! they stop. A conversion or the benchmark pauses it outright (`busy`).
//!
//! Node measures its event loop's delay; this server has no event loop, so
//! the same numbers come from a thread that sleeps 20 ms at a time and notes
//! how late it wakes (a machine too busy to run it on time is strained in
//! the same way).

use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

const LAG_P99_MS: f64 = 100.0;
const STALL_MS: f64 = 1000.0;
const STALL_PAUSE_MS: f64 = 5000.0;
const CALM_MS: f64 = 10_000.0;
const HOLD_MS: f64 = 15_000.0;
const TRIAL_MS: f64 = 20_000.0;
const RATE_MS: f64 = 10_000.0;
const VIEWER_MS: f64 = 30_000.0;

/// The delays seen since the last reset (ms): the 99th percentile and the worst.
pub trait Lag: Send + Sync {
    fn p99(&self) -> f64;
    fn max(&self) -> f64;
    fn reset(&self);
}

/// Wake-up delays of a thread sleeping 20 ms at a time (monitorEventLoopDelay({ resolution: 20 })).
pub struct SleepLag {
    seen: Mutex<Vec<f64>>,
}

impl SleepLag {
    pub fn start() -> Arc<SleepLag> {
        let me = Arc::new(SleepLag { seen: Mutex::new(Vec::new()) });
        let w = Arc::downgrade(&me);
        std::thread::Builder::new()
            .name("pace-lag".into())
            .spawn(move || loop {
                let t = Instant::now();
                std::thread::sleep(Duration::from_millis(20));
                let late = (t.elapsed().as_secs_f64() * 1000.0 - 20.0).max(0.0);
                match w.upgrade() {
                    Some(l) => {
                        let mut s = l.seen.lock().unwrap();
                        if s.len() < 10_000 {
                            s.push(late);
                        }
                    }
                    None => return,
                }
            })
            .ok();
        me
    }
}

impl Lag for SleepLag {
    fn p99(&self) -> f64 {
        let mut s = self.seen.lock().unwrap().clone();
        if s.is_empty() {
            return 0.0;
        }
        s.sort_by(|a, b| a.partial_cmp(b).unwrap());
        s[((s.len() as f64 * 0.99).ceil() as usize).saturating_sub(1).min(s.len() - 1)]
    }
    fn max(&self) -> f64 {
        self.seen.lock().unwrap().iter().cloned().fold(0.0, f64::max)
    }
    fn reset(&self) {
        self.seen.lock().unwrap().clear();
    }
}

struct Trial {
    from: u32,
    rate: f64,
    until: f64,
}

struct State {
    limit: u32,
    strikes: u32,
    calm_since: f64,
    hold_until: f64,
    paused_until: f64,
    viewers: u32,
    viewer_until: f64,
    active: usize,
    pending: bool,
    recent: Option<f64>,
    best: Option<f64>,
    finished: Vec<f64>,
    trial: Option<Trial>,
}

pub struct Pace {
    max: Box<dyn Fn() -> u32 + Send + Sync>,
    busy: Box<dyn Fn() -> bool + Send + Sync>,
    now: Box<dyn Fn() -> f64 + Send + Sync>,
    lag: Arc<dyn Lag>,
    st: Mutex<State>,
    fixed: bool,
}

/// The Viewer plays footage while this lives (backgroundPace.viewer(res)).
pub struct Watching(Arc<Pace>);

impl Drop for Watching {
    fn drop(&mut self) {
        let mut s = self.0.st.lock().unwrap();
        s.viewers = s.viewers.saturating_sub(1);
        s.viewer_until = (self.0.now)() + VIEWER_MS;
    }
}

impl Pace {
    pub fn new(max: impl Fn() -> u32 + Send + Sync + 'static, busy: impl Fn() -> bool + Send + Sync + 'static, now: impl Fn() -> f64 + Send + Sync + 'static, lag: Arc<dyn Lag>) -> Pace {
        let t = now();
        Pace {
            max: Box::new(max),
            busy: Box::new(busy),
            now: Box::new(now),
            lag,
            fixed: false,
            st: Mutex::new(State { limit: 1, strikes: 0, calm_since: t, hold_until: 0.0, paused_until: 0.0, viewers: 0, viewer_until: 0.0, active: 0, pending: false, recent: None, best: None, finished: Vec::new(), trial: None }),
        }
    }

    /// The old pace: one clip at a time, none while busy (fixedPace).
    pub fn fixed(busy: impl Fn() -> bool + Send + Sync + 'static) -> Pace {
        struct None_;
        impl Lag for None_ {
            fn p99(&self) -> f64 {
                0.0
            }
            fn max(&self) -> f64 {
                0.0
            }
            fn reset(&self) {}
        }
        let mut p = Pace::new(|| 1, busy, crate::scanner::now_ms, Arc::new(None_));
        p.fixed = true;
        p
    }

    fn most(&self) -> u32 {
        (self.max)().max(1)
    }

    fn rate(s: &State, t: f64, span: f64) -> f64 {
        s.finished.iter().filter(|&&x| x > t - span).count() as f64 / (span / 60_000.0)
    }

    pub fn tick(&self) {
        self.tick_at((self.now)())
    }

    pub fn tick_at(&self, t: f64) {
        if self.fixed {
            return;
        }
        let mut s = self.st.lock().unwrap();
        let busiest = s.active;
        s.active = 0;
        let p99 = self.lag.p99();
        let worst = self.lag.max();
        self.lag.reset();
        while s.finished.first().is_some_and(|&x| x < t - 120_000.0) {
            s.finished.remove(0);
        }
        if let Some(b) = s.best.as_mut() {
            *b *= 1.002;
        }
        if worst > STALL_MS {
            s.limit = 1;
            s.paused_until = t + STALL_PAUSE_MS;
            s.hold_until = t + HOLD_MS;
            s.calm_since = t;
            s.strikes = 0;
            s.trial = None;
            return;
        }
        let slow = matches!((s.recent, s.best), (Some(r), Some(b)) if r > b * 2.0);
        if p99 > LAG_P99_MS || slow {
            s.calm_since = t;
            s.strikes += 1;
            if s.strikes >= 2 {
                s.limit = (s.limit / 2).max(1);
                s.hold_until = t + HOLD_MS;
                s.strikes = 0;
                s.trial = None;
            }
            return;
        }
        s.strikes = 0;
        if let Some(tr) = s.trial.as_ref().filter(|tr| t >= tr.until) {
            let (from, rate) = (tr.from, tr.rate);
            if Self::rate(&s, t, RATE_MS) < rate * 1.1 {
                s.limit = from;
                s.hold_until = t + 4.0 * HOLD_MS;
            }
            s.trial = None;
            s.calm_since = t;
            return;
        }
        let most = self.most();
        if s.limit > most {
            s.limit = most;
        }
        if s.trial.is_none() && s.limit < most && s.pending && busiest >= s.limit as usize && t >= s.hold_until && t - s.calm_since >= CALM_MS {
            let rate = Self::rate(&s, t, RATE_MS);
            s.trial = Some(Trial { from: s.limit, rate, until: t + TRIAL_MS });
            s.limit += 1;
            s.calm_since = t;
        }
    }

    /// How many clips may be in reading now: 0 while paused.
    pub fn allowed(&self) -> u32 {
        self.allowed_at((self.now)())
    }

    pub fn allowed_at(&self, t: f64) -> u32 {
        if (self.busy)() {
            return 0;
        }
        if self.fixed {
            return 1;
        }
        let s = self.st.lock().unwrap();
        if t < s.paused_until {
            return 0;
        }
        if s.viewers > 0 || t < s.viewer_until {
            return 1;
        }
        s.limit.min(self.most())
    }

    pub fn demand(&self, in_reading: usize, more: bool) {
        let mut s = self.st.lock().unwrap();
        s.active = s.active.max(in_reading);
        s.pending = more;
    }

    pub fn done(&self, ms: f64) {
        self.done_at(ms, (self.now)())
    }

    pub fn done_at(&self, ms: f64, t: f64) {
        if self.fixed {
            return;
        }
        let mut s = self.st.lock().unwrap();
        s.finished.push(t);
        let recent = match s.recent {
            None => ms,
            Some(r) => r * 0.8 + ms * 0.2,
        };
        s.recent = Some(recent);
        if s.best.map_or(true, |b| recent < b) {
            s.best = Some(recent);
        }
    }

    /// Footage is playing in the Viewer until the guard is dropped.
    pub fn viewer(self: &Arc<Self>) -> Watching {
        self.st.lock().unwrap().viewers += 1;
        Watching(self.clone())
    }

    /// Footage plays in the Viewer, or did less than VIEWER_MS ago: background reading that
    /// would compete with it waits (scrub previews made ahead) or reads one clip at a time.
    pub fn viewing(&self) -> bool {
        self.viewing_at((self.now)())
    }

    pub fn viewing_at(&self, t: f64) -> bool {
        let s = self.st.lock().unwrap();
        s.viewers > 0 || t < s.viewer_until
    }

    /// Under strain right now: other background work waits too.
    pub fn strained(&self) -> bool {
        if self.fixed {
            return false;
        }
        let t = (self.now)();
        let s = self.st.lock().unwrap();
        t < s.paused_until || s.strikes > 0 || t < s.hold_until
    }

    /// { limit, viewers, paused }
    pub fn status(&self) -> (u32, u32, bool) {
        if self.fixed {
            return (1, 0, false);
        }
        let s = self.st.lock().unwrap();
        (s.limit, s.viewers, (self.now)() < s.paused_until)
    }

    /// tick() once a second
    pub fn start(self: &Arc<Self>) {
        let w = Arc::downgrade(self);
        std::thread::Builder::new()
            .name("pace".into())
            .spawn(move || loop {
                std::thread::sleep(Duration::from_secs(1));
                match w.upgrade() {
                    Some(p) => p.tick(),
                    None => return,
                }
            })
            .ok();
    }
}

#[cfg(test)]
mod tests {
    // test/backgroundPace.test.js, with simulated time and lateness
    use super::*;
    use crate::sei::js_round;
    use std::sync::atomic::{AtomicBool, Ordering};

    struct FakeLag {
        v: Mutex<(f64, f64)>,
    }
    impl Lag for FakeLag {
        fn p99(&self) -> f64 {
            self.v.lock().unwrap().0
        }
        fn max(&self) -> f64 {
            self.v.lock().unwrap().1
        }
        fn reset(&self) {}
    }

    struct Sim {
        pace: Arc<Pace>,
        t: Arc<Mutex<f64>>,
        lag: Arc<FakeLag>,
    }

    #[derive(Clone, Copy)]
    struct Run {
        p99: f64,
        max: f64,
        /// None: 'all' (what is allowed each second); Some(usize::MAX): what was allowed when the run began
        reading: Option<usize>,
        every: f64,
        ms: f64,
    }
    const RUN: Run = Run { p99: 5.0, max: 20.0, reading: Some(usize::MAX), every: 500.0, ms: 400.0 };
    const ALL: Run = Run { reading: None, ..RUN };

    fn sim(busy: Arc<AtomicBool>) -> Sim {
        let t = Arc::new(Mutex::new(1_000_000.0));
        let lag = Arc::new(FakeLag { v: Mutex::new((5.0, 20.0)) });
        let tc = t.clone();
        let pace = Arc::new(Pace::new(|| 4, move || busy.load(Ordering::SeqCst), move || *tc.lock().unwrap(), lag.clone()));
        Sim { pace, t, lag }
    }

    impl Sim {
        fn now(&self) -> f64 {
            *self.t.lock().unwrap()
        }
        fn run(&self, n: usize, r: Run) {
            let start = self.pace.allowed_at(self.now()) as usize;
            for _ in 0..n {
                *self.lag.v.lock().unwrap() = (r.p99, r.max);
                let t = self.now();
                let mut at = 0.0;
                while at < 1000.0 {
                    self.pace.done_at(r.ms, t + at);
                    at += r.every;
                }
                *self.t.lock().unwrap() += 1000.0;
                let t = self.now();
                let reading = match r.reading {
                    None => self.pace.allowed_at(t) as usize,
                    Some(usize::MAX) => start,
                    Some(k) => k,
                };
                self.pace.demand(reading, true);
                self.pace.tick_at(t);
            }
        }
    }

    fn new() -> Sim {
        sim(Arc::new(AtomicBool::new(false)))
    }

    #[test]
    fn one_at_first_one_more_after_calm_seconds() {
        let s = new();
        assert_eq!(s.pace.allowed(), 1);
        s.run(12, ALL);
        assert_eq!(s.pace.allowed(), 2);
    }

    #[test]
    fn a_step_that_reads_no_more_is_taken_back() {
        let s = new();
        s.run(12, ALL);
        assert_eq!(s.pace.allowed(), 2);
        s.run(21, ALL);
        assert_eq!(s.pace.allowed(), 1);
        s.run(30, ALL);
        assert_eq!(s.pace.allowed(), 1, "held off a good while before trying again");
    }

    #[test]
    fn a_step_that_reads_more_is_kept_up_to_the_most() {
        let s = new();
        let mut every = 500.0;
        for _ in 0..12 {
            s.run(12, Run { every, ..ALL });
            every = js_round(every / 1.6).max(50.0);
            s.run(21, Run { every, ..ALL });
        }
        assert_eq!(s.pace.allowed(), 4);
    }

    #[test]
    fn lag_halves_and_a_stall_stops_a_moment() {
        let s = new();
        let mut every = 500.0;
        for _ in 0..3 {
            s.run(12, Run { every, ..ALL });
            every = js_round(every / 1.6);
            s.run(21, Run { every, ..ALL });
        }
        let before = s.pace.allowed();
        assert!(before >= 3);
        s.run(1, Run { p99: 150.0, every, ..RUN });
        assert_eq!(s.pace.allowed(), before, "one late second is not enough");
        s.run(1, Run { p99: 150.0, every, ..RUN });
        assert_eq!(s.pace.allowed(), before / 2);
        assert!(s.pace.strained());
        s.run(1, Run { max: 2500.0, every, ..RUN });
        assert_eq!(s.pace.allowed(), 0);
        s.run(5, Run { every, ..RUN });
        assert_eq!(s.pace.allowed(), 1);
    }

    #[test]
    fn slow_reads_are_strain() {
        let s = new();
        s.run(5, Run { ms: 300.0, ..RUN });
        s.run(1, Run { ms: 3000.0, ..RUN });
        s.run(1, Run { ms: 3000.0, ..RUN });
        assert!(s.pace.strained());
    }

    #[test]
    fn the_viewer_and_busy() {
        let busy = Arc::new(AtomicBool::new(false));
        let s = sim(busy.clone());
        let mut every = 500.0;
        for _ in 0..2 {
            s.run(12, Run { every, ..ALL });
            every = js_round(every / 1.6);
            s.run(21, Run { every, ..ALL });
        }
        assert!(s.pace.allowed() >= 2);
        assert!(!s.pace.viewing());
        let w = s.pace.viewer();
        assert_eq!(s.pace.allowed(), 1);
        assert!(s.pace.viewing());
        drop(w);
        assert!(s.pace.viewing_at(s.now() + 29_000.0), "a while after the Viewer stopped");
        assert!(!s.pace.viewing_at(s.now() + 31_000.0));
        assert_eq!(s.pace.status().1, 0);
        assert_eq!(s.pace.allowed_at(s.now()), 1);
        assert!(s.pace.allowed_at(s.now() + 31_000.0) >= 2);
        busy.store(true, Ordering::SeqCst);
        assert_eq!(s.pace.allowed_at(s.now() + 31_000.0), 0);
    }

    #[test]
    fn a_slot_in_use_at_any_moment_counts() {
        let s = new();
        for _ in 0..12 {
            s.pace.demand(1, true);
            s.pace.demand(0, true);
            s.run(1, Run { reading: Some(0), ..RUN });
        }
        assert_eq!(s.pace.allowed(), 2);
    }

    #[test]
    fn never_more_than_its_limit_read_each_time() {
        let most = Arc::new(Mutex::new(3u32));
        let m = most.clone();
        let t = Arc::new(Mutex::new(1_000_000.0));
        let tc = t.clone();
        let lag = Arc::new(FakeLag { v: Mutex::new((5.0, 20.0)) });
        let pace = Pace::new(move || *m.lock().unwrap(), || false, move || *tc.lock().unwrap(), lag);
        for _ in 0..200 {
            let now = *t.lock().unwrap();
            for k in 0..8 {
                pace.done_at(100.0, now + k as f64 * 100.0);
            }
            *t.lock().unwrap() += 1000.0;
            pace.demand(pace.allowed() as usize, true);
            pace.tick();
            assert!(pace.allowed() <= *most.lock().unwrap());
        }
        *most.lock().unwrap() = 1;
        assert_eq!(pace.allowed(), 1);
    }
}
