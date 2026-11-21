//! Reading a request body with Node's limits (index.js: `srv.setTimeout(120_000)` and
//! `srv.requestTimeout = 10 * 60_000`): a body that sends nothing for 2 minutes, or is not
//! all there within 10, ends with 408 and `Connection: close`, so its connection closes
//! (on the device port that gives its address's connection back). Only request bodies:
//! answers (video, live updates, exports, downloads) run as long as they need.

use super::http::{error_json, Res};
use axum::http::{header, HeaderValue};
use bytes::Bytes;
use http_body_util::BodyExt;
use std::time::Duration;
use tokio::time::Instant;

/// A body that sends nothing for this long is given up (Node: `setTimeout(120_000)`).
pub const IDLE: Duration = Duration::from_secs(120);
/// A body not all there after this long is given up (Node: `requestTimeout`).
pub const WHOLE: Duration = Duration::from_secs(10 * 60);

pub const TIMED_OUT_TEXT: &str = "The request took too long to arrive.";

#[derive(Debug)]
pub enum BodyError {
    /// more than the limit
    TooLarge,
    /// nothing for IDLE, or not all there within WHOLE
    TimedOut,
    /// the connection failed while it was read
    Failed(String),
}

/// The whole body, up to `limit` bytes, within IDLE and WHOLE.
pub async fn collect<B>(body: B, limit: usize) -> Result<Bytes, BodyError>
where
    B: hyper::body::Body<Data = Bytes>,
    B::Error: Into<Box<dyn std::error::Error + Send + Sync>>,
{
    let whole = Instant::now() + WHOLE;
    let mut b = std::pin::pin!(http_body_util::Limited::new(body, limit));
    let mut parts: Vec<Bytes> = Vec::new();
    loop {
        let until = (Instant::now() + IDLE).min(whole);
        match tokio::time::timeout_at(until, b.frame()).await {
            Err(_) => return Err(BodyError::TimedOut),
            Ok(None) => break,
            Ok(Some(Ok(frame))) => {
                if let Ok(d) = frame.into_data() {
                    if !d.is_empty() {
                        parts.push(d);
                    }
                }
            }
            Ok(Some(Err(e))) => {
                if e.downcast_ref::<http_body_util::LengthLimitError>().is_some() {
                    return Err(BodyError::TooLarge);
                }
                return Err(BodyError::Failed(e.to_string()));
            }
        }
    }
    Ok(match parts.len() {
        0 => Bytes::new(),
        1 => parts.pop().unwrap(),
        _ => Bytes::from(parts.concat()),
    })
}

/// The body as a stream of its bytes for a reader that takes it as it comes (a node's
/// upload): ends with a TimedOut error after IDLE without a byte. No WHOLE here: Node's web
/// port (an HTTP/2 server) had only the idle limit, and a long upload must keep going.
pub fn idle_bounded<B>(body: B) -> impl futures_core::Stream<Item = std::io::Result<Bytes>> + Send
where
    B: hyper::body::Body<Data = Bytes> + Send + Unpin + 'static,
    B::Error: Into<Box<dyn std::error::Error + Send + Sync>>,
{
    futures_util::stream::unfold(Some(body), |b| async move {
        let mut b = b?;
        loop {
            return match tokio::time::timeout(IDLE, b.frame()).await {
                Err(_) => Some((Err(std::io::Error::new(std::io::ErrorKind::TimedOut, TIMED_OUT_TEXT)), None)),
                Ok(None) => None,
                Ok(Some(Ok(frame))) => match frame.into_data() {
                    Ok(d) => Some((Ok(d), Some(b))),
                    Err(_) => continue,
                },
                Ok(Some(Err(e))) => Some((Err(std::io::Error::other(e)), None)),
            };
        }
    })
}

/// Marks an answer as the last on its connection (hyper then closes it; HTTP/2 drops the header).
pub fn close_after(r: &mut Res) {
    r.headers_mut().insert(header::CONNECTION, HeaderValue::from_static("close"));
}

/// 408 for a body that took too long, closing the connection.
pub fn timed_out(accept: &str) -> Res {
    let mut r = error_json(408, TIMED_OUT_TEXT, None, accept);
    close_after(&mut r);
    r
}

#[cfg(test)]
mod tests {
    use super::*;
    use futures_util::StreamExt;

    type Sent = Result<hyper::body::Frame<Bytes>, std::convert::Infallible>;

    fn channel() -> (tokio::sync::mpsc::Sender<Sent>, http_body_util::StreamBody<tokio_stream_shim::Rx>) {
        let (tx, rx) = tokio::sync::mpsc::channel(4);
        (tx, http_body_util::StreamBody::new(tokio_stream_shim::Rx(rx)))
    }

    mod tokio_stream_shim {
        pub struct Rx(pub tokio::sync::mpsc::Receiver<super::Sent>);
        impl futures_core::Stream for Rx {
            type Item = super::Sent;
            fn poll_next(mut self: std::pin::Pin<&mut Self>, cx: &mut std::task::Context<'_>) -> std::task::Poll<Option<Self::Item>> {
                self.0.poll_recv(cx)
            }
        }
    }

    fn data(b: &'static [u8]) -> Sent {
        Ok(hyper::body::Frame::data(Bytes::from_static(b)))
    }

    #[tokio::test(start_paused = true)]
    async fn a_body_that_stops_sending_times_out_after_the_idle_limit() {
        let (tx, body) = channel();
        tx.send(data(b"part")).await.unwrap();
        let began = Instant::now();
        let r = tokio::time::timeout(Duration::from_secs(3600), collect(body, 1024)).await;
        assert!(matches!(r, Ok(Err(BodyError::TimedOut))), "{r:?}");
        assert_eq!(began.elapsed(), IDLE);
        drop(tx);
    }

    #[tokio::test(start_paused = true)]
    async fn a_slow_but_steady_body_is_read_until_the_whole_limit() {
        let (tx, body) = channel();
        let sender = tokio::spawn(async move {
            for _ in 0..9 {
                tx.send(data(b"x")).await.unwrap();
                tokio::time::sleep(Duration::from_secs(60)).await;
            }
        });
        // nine bytes over 8 minutes: all of it arrives
        assert_eq!(collect(body, 1024).await.unwrap(), Bytes::from_static(b"xxxxxxxxx"));
        sender.await.unwrap();
        // one that goes on past 10 minutes is given up at 10
        let (tx, body) = channel();
        tokio::spawn(async move {
            loop {
                if tx.send(data(b"x")).await.is_err() {
                    return;
                }
                tokio::time::sleep(Duration::from_secs(60)).await;
            }
        });
        let began = Instant::now();
        assert!(matches!(collect(body, 1024).await, Err(BodyError::TimedOut)));
        assert_eq!(began.elapsed(), WHOLE);
    }

    #[tokio::test]
    async fn too_large_is_still_too_large() {
        let (tx, body) = channel();
        tx.send(data(b"0123456789")).await.unwrap();
        drop(tx);
        assert!(matches!(collect(body, 4).await, Err(BodyError::TooLarge)));
    }

    #[tokio::test(start_paused = true)]
    async fn a_streamed_body_ends_after_the_idle_limit_only() {
        let (tx, body) = channel();
        let sender = tokio::spawn(async move {
            for _ in 0..12 {
                tx.send(data(b"x")).await.unwrap();
                tokio::time::sleep(Duration::from_secs(60)).await;
            }
            // then nothing (the connection is kept open)
            tokio::time::sleep(Duration::from_secs(3600)).await;
            drop(tx);
        });
        let s = std::pin::pin!(idle_bounded(body));
        let got: Vec<std::io::Result<Bytes>> = s.collect().await;
        assert_eq!(got.len(), 13, "12 bytes over 12 minutes, then the idle limit");
        assert!(got[..12].iter().all(|r| r.is_ok()));
        assert_eq!(got[12].as_ref().unwrap_err().kind(), std::io::ErrorKind::TimedOut);
        sender.abort();
    }
}
