//! One job queue for the server's background work, with priorities and a
//! limit taken from the machine: scans first, then codec probes, then the
//! speed index. A job with the same key as one already waiting is not added
//! twice. Jobs are plain blocking functions run on the queue's own threads,
//! so file I/O never stalls the HTTP side.

use std::collections::{BinaryHeap, HashSet};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Condvar, Mutex};

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum Priority {
    Low = 0,
    Normal = 1,
    High = 2,
}

type Work = Box<dyn FnOnce() + Send + 'static>;

struct Job {
    priority: Priority,
    seq: u64,
    key: String,
    work: Work,
}

impl PartialEq for Job {
    fn eq(&self, o: &Self) -> bool {
        self.priority == o.priority && self.seq == o.seq
    }
}
impl Eq for Job {}
impl PartialOrd for Job {
    fn partial_cmp(&self, o: &Self) -> Option<std::cmp::Ordering> {
        Some(self.cmp(o))
    }
}
impl Ord for Job {
    // higher priority first, then first come first served
    fn cmp(&self, o: &Self) -> std::cmp::Ordering {
        self.priority.cmp(&o.priority).then(o.seq.cmp(&self.seq))
    }
}

#[derive(Default)]
struct State {
    heap: BinaryHeap<Job>,
    waiting: HashSet<String>,
    running: HashSet<String>,
    seq: u64,
}

pub struct Jobs {
    state: Mutex<State>,
    wake: Condvar,
    pub workers: usize,
    done: AtomicUsize,
}

impl Jobs {
    /// A queue with `workers` threads (0: from the machine, two to four).
    pub fn start(workers: usize) -> Arc<Jobs> {
        let n = if workers > 0 { workers } else { std::thread::available_parallelism().map_or(2, |n| n.get()).clamp(2, 4) };
        let jobs = Arc::new(Jobs { state: Mutex::new(State::default()), wake: Condvar::new(), workers: n, done: AtomicUsize::new(0) });
        for i in 0..n {
            let j = jobs.clone();
            std::thread::Builder::new().name(format!("job-{i}")).spawn(move || j.run()).expect("job thread");
        }
        jobs
    }

    /// Queue work under a key; false when the same key is already waiting.
    pub fn submit(&self, key: impl Into<String>, priority: Priority, work: impl FnOnce() + Send + 'static) -> bool {
        let key = key.into();
        let mut s = self.state.lock().unwrap();
        if !s.waiting.insert(key.clone()) {
            return false;
        }
        s.seq += 1;
        let seq = s.seq;
        s.heap.push(Job { priority, seq, key, work: Box::new(work) });
        self.wake.notify_one();
        true
    }

    /// Whether a job with this key is waiting or running.
    pub fn busy(&self, key: &str) -> bool {
        let s = self.state.lock().unwrap();
        s.waiting.contains(key) || s.running.contains(key)
    }

    pub fn finished(&self) -> usize {
        self.done.load(Ordering::Relaxed)
    }

    fn run(&self) {
        loop {
            let job = {
                let mut s = self.state.lock().unwrap();
                loop {
                    // a key runs once at a time: skip to another while it is running
                    let mut held = Vec::new();
                    let mut pick = None;
                    while let Some(j) = s.heap.pop() {
                        if s.running.contains(&j.key) {
                            held.push(j);
                        } else {
                            pick = Some(j);
                            break;
                        }
                    }
                    s.heap.extend(held);
                    if let Some(j) = pick {
                        s.waiting.remove(&j.key);
                        s.running.insert(j.key.clone());
                        break j;
                    }
                    s = self.wake.wait(s).unwrap();
                }
            };
            let key = job.key.clone();
            // (a job that panics must not take the queue down)
            let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(job.work));
            self.state.lock().unwrap().running.remove(&key);
            self.done.fetch_add(1, Ordering::Relaxed);
            self.wake.notify_all();
        }
    }
}

/// Run f over items on up to `threads` threads (a bounded parallel map for file reads).
pub fn par_each<T: Sync, R: Send>(items: &[T], threads: usize, f: impl Fn(&T) -> R + Sync) -> Vec<R> {
    let next = AtomicUsize::new(0);
    let out: Mutex<Vec<(usize, R)>> = Mutex::new(Vec::with_capacity(items.len()));
    std::thread::scope(|s| {
        for _ in 0..threads.clamp(1, items.len().max(1)) {
            s.spawn(|| loop {
                let i = next.fetch_add(1, Ordering::Relaxed);
                if i >= items.len() {
                    return;
                }
                let r = f(&items[i]);
                out.lock().unwrap().push((i, r));
            });
        }
    });
    let mut v = out.into_inner().unwrap();
    v.sort_by_key(|x| x.0);
    v.into_iter().map(|x| x.1).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    #[test]
    fn priorities_and_keys() {
        let jobs = Jobs::start(1);
        let order = Arc::new(Mutex::new(Vec::new()));
        let gate = Arc::new((Mutex::new(false), Condvar::new()));
        // hold the only worker while the others queue up
        let g = gate.clone();
        jobs.submit("hold", Priority::High, move || {
            let (m, c) = &*g;
            let mut open = m.lock().unwrap();
            while !*open {
                open = c.wait(open).unwrap();
            }
        });
        std::thread::sleep(Duration::from_millis(50));
        for (k, p) in [("low", Priority::Low), ("normal", Priority::Normal), ("high", Priority::High)] {
            let o = order.clone();
            assert!(jobs.submit(k, p, move || o.lock().unwrap().push(k)));
        }
        assert!(!jobs.submit("low", Priority::Low, || {}), "same key waiting: not added twice");
        *gate.0.lock().unwrap() = true;
        gate.1.notify_all();
        while jobs.finished() < 4 {
            std::thread::sleep(Duration::from_millis(10));
        }
        assert_eq!(*order.lock().unwrap(), vec!["high", "normal", "low"]);
        assert_eq!(par_each(&[1, 2, 3, 4], 3, |x| x * 10), vec![10, 20, 30, 40]);
    }
}
