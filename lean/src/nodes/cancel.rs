//! An AbortController / AbortSignal for threads: abort() runs every
//! listener once; a listener added after the abort runs at once.

use std::sync::{Arc, Mutex};

type Listener = Box<dyn FnOnce() + Send>;

#[derive(Default)]
struct Inner {
    aborted: bool,
    next: u64,
    listeners: Vec<(u64, Listener)>,
}

#[derive(Clone, Default)]
pub struct Cancel(Arc<Mutex<Inner>>);

impl Cancel {
    pub fn new() -> Cancel {
        Cancel::default()
    }

    pub fn aborted(&self) -> bool {
        self.0.lock().unwrap().aborted
    }

    pub fn abort(&self) {
        let list = {
            let mut g = self.0.lock().unwrap();
            if g.aborted {
                return;
            }
            g.aborted = true;
            std::mem::take(&mut g.listeners)
        };
        for (_, f) in list {
            f();
        }
    }

    /// Runs `f` on abort (at once when already aborted); the id removes it.
    pub fn on_abort(&self, f: impl FnOnce() + Send + 'static) -> u64 {
        let mut g = self.0.lock().unwrap();
        if g.aborted {
            drop(g);
            f();
            return 0;
        }
        g.next += 1;
        let id = g.next;
        g.listeners.push((id, Box::new(f)));
        id
    }

    pub fn remove(&self, id: u64) {
        self.0.lock().unwrap().listeners.retain(|(i, _)| *i != id);
    }
}
