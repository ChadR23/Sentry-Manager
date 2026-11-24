//! Live updates (`GET /api/events`, index.js): Server-Sent Events, `hello`
//! once, then `changed` with `{ "topics": [...] }`. Topics announced within
//! 400 ms go out together, in the order they were first announced; a
//! `: ping` comment every 20 s; at most 200 open streams (503 beyond).

use bytes::Bytes;
use indexmap::IndexSet;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::sync::mpsc;

pub const MAX_EVENT_CLIENTS: usize = 200;
pub const BATCH_MS: u64 = 400;
pub const PING_MS: u64 = 20_000;
const QUEUED_CHANGES: usize = 64;

#[derive(Default)]
struct Inner {
    clients: Vec<(u64, mpsc::Sender<Bytes>)>,
    next: u64,
    pending: IndexSet<String>,
    timer: bool,
}

#[derive(Default)]
pub struct Hub {
    inner: Mutex<Inner>,
}

/// One open stream; it leaves the hub when dropped (the browser went away).
pub struct Subscription {
    hub: Arc<Hub>,
    id: u64,
    pub rx: mpsc::Receiver<Bytes>,
}

impl Drop for Subscription {
    fn drop(&mut self) {
        self.hub.inner.lock().unwrap().clients.retain(|(i, _)| *i != self.id);
    }
}

pub fn changed_frame(topics: &[String]) -> String {
    format!("event: changed\ndata: {}\n\n", serde_json::json!({ "topics": topics }))
}

impl Hub {
    pub fn new() -> Arc<Hub> {
        Arc::new(Hub::default())
    }

    pub fn clients(&self) -> usize {
        self.inner.lock().unwrap().clients.len()
    }

    /// A new stream, or None when 200 are open already.
    pub fn subscribe(self: &Arc<Self>) -> Option<Subscription> {
        let mut i = self.inner.lock().unwrap();
        if i.clients.len() >= MAX_EVENT_CLIENTS {
            return None;
        }
        let (tx, rx) = mpsc::channel(QUEUED_CHANGES);
        i.next += 1;
        let id = i.next;
        i.clients.push((id, tx));
        Some(Subscription { hub: self.clone(), id, rx })
    }

    /// Something changed: every open page hears of it within 400 ms (with whatever else changed meanwhile).
    pub fn announce(self: &Arc<Self>, topic: &str) {
        let mut i = self.inner.lock().unwrap();
        i.pending.insert(topic.to_string());
        if i.timer {
            return;
        }
        i.timer = true;
        drop(i);
        let hub = self.clone();
        match tokio::runtime::Handle::try_current() {
            Ok(h) => {
                h.spawn(async move {
                    tokio::time::sleep(Duration::from_millis(BATCH_MS)).await;
                    hub.flush();
                });
            }
            Err(_) => {
                std::thread::spawn(move || {
                    std::thread::sleep(Duration::from_millis(BATCH_MS));
                    hub.flush();
                });
            }
        }
    }

    fn flush(&self) {
        let mut i = self.inner.lock().unwrap();
        i.timer = false;
        let topics: Vec<String> = i.pending.drain(..).collect();
        if topics.is_empty() {
            return;
        }
        let frame = Bytes::from(changed_frame(&topics));
        // A stalled client reconnects for current state, rather than retaining every
        // inventory/job change for the rest of a long conversion.
        i.clients.retain(|(_, tx)| tx.try_send(frame.clone()).is_ok());
    }

    /// Server shutting down: every stream ends.
    pub fn close_all(&self) {
        self.inner.lock().unwrap().clients.clear();
    }
}

/// The body of an /api/events answer: hello, the changes, a ping every 20 s.
pub fn stream_body(sub: Subscription) -> axum::body::Body {
    let hello = futures_util::stream::once(async { Ok::<Bytes, std::io::Error>(Bytes::from_static(b"event: hello\ndata: {}\n\n")) });
    let mut ping = tokio::time::interval_at(tokio::time::Instant::now() + Duration::from_millis(PING_MS), Duration::from_millis(PING_MS));
    ping.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    let rest = futures_util::stream::unfold((sub, ping), |(mut sub, mut ping)| async move {
        tokio::select! {
            m = sub.rx.recv() => m.map(|b| (Ok(b), (sub, ping))),
            _ = ping.tick() => Some((Ok(Bytes::from_static(b": ping\n\n")), (sub, ping))),
        }
    });
    axum::body::Body::from_stream(futures_util::StreamExt::chain(hello, rest))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test(start_paused = true)]
    async fn memory_bound_slow_change_client_does_not_retain_job_history() {
        let hub = Hub::new();
        let _slow = hub.subscribe().unwrap();
        let mut fast = hub.subscribe().unwrap();
        for _ in 0..128 {
            hub.announce("inventory");
            hub.flush();
            assert_eq!(&fast.rx.try_recv().unwrap()[..], b"event: changed\ndata: {\"topics\":[\"inventory\"]}\n\n");
        }
        assert_eq!(hub.clients(), 1, "the slow client must be disconnected; the draining client stays connected");
    }

    #[tokio::test(start_paused = true)]
    async fn batches_within_400ms() {
        let hub = Hub::new();
        let mut a = hub.subscribe().unwrap();
        hub.announce("jobs");
        hub.announce("vehicles");
        hub.announce("jobs");
        assert!(a.rx.try_recv().is_err());
        tokio::time::sleep(Duration::from_millis(401)).await;
        let got = a.rx.recv().await.unwrap();
        assert_eq!(&got[..], b"event: changed\ndata: {\"topics\":[\"jobs\",\"vehicles\"]}\n\n");
        hub.announce("bin");
        tokio::time::sleep(Duration::from_millis(401)).await;
        assert_eq!(&a.rx.recv().await.unwrap()[..], b"event: changed\ndata: {\"topics\":[\"bin\"]}\n\n");
        drop(a);
        assert_eq!(hub.clients(), 0);
    }

    #[test]
    fn at_most_200() {
        let hub = Hub::new();
        let subs: Vec<_> = (0..MAX_EVENT_CLIENTS).map(|_| hub.subscribe().unwrap()).collect();
        assert!(hub.subscribe().is_none());
        drop(subs);
        assert!(hub.subscribe().is_some());
    }
}
