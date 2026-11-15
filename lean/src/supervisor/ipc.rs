//! The channel between the supervisor and the app: what Node's child-process
//! IPC channel was (`stdio: [..., 'ipc']`), which is itself newline-delimited
//! JSON over a Unix socketpair on an inherited descriptor.
//!
//! - The supervisor makes an `AF_UNIX` `SOCK_STREAM` socketpair (close-on-exec)
//!   and gives one end to the app as descriptor 3 (`SENTRY_SUPERVISOR_FD=3`).
//! - Each message is one JSON value on one line, UTF-8, ended by `\n`
//!   (serde_json never writes a raw newline inside a value).
//! - A line longer than `MAX_LINE` is dropped, as is a line that is not JSON.
//! - The channel is closed when either side closes or exits (end of file):
//!   for the app that means the supervisor is gone (Node's 'disconnect').

use serde_json::Value;
use std::io;
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::sync::mpsc;

/// The longest message line accepted (1 MiB).
pub const MAX_LINE: usize = 1 << 20;
/// The descriptor number the app finds its end on.
pub const CHILD_FD: i32 = 3;
pub const FD_ENV: &str = "SENTRY_SUPERVISOR_FD";

/// A connected pair, both ends close-on-exec.
pub fn socketpair() -> io::Result<(OwnedFd, OwnedFd)> {
    let mut fds = [0i32; 2];
    // SAFETY: fds is a valid out array of two ints
    let r = unsafe { libc::socketpair(libc::AF_UNIX, libc::SOCK_STREAM | libc::SOCK_CLOEXEC, 0, fds.as_mut_ptr()) };
    if r != 0 {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: both descriptors were just created and are owned by nobody else
    Ok(unsafe { (OwnedFd::from_raw_fd(fds[0]), OwnedFd::from_raw_fd(fds[1])) })
}

/// The sending half. Cheap to clone; `send` never blocks.
#[derive(Clone)]
pub struct Sender {
    tx: mpsc::UnboundedSender<Vec<u8>>,
    connected: Arc<AtomicBool>,
}

impl Sender {
    /// Node's `child.connected` / `process.connected`.
    pub fn connected(&self) -> bool {
        self.connected.load(Ordering::SeqCst)
    }

    /// Queue one message. Fails ("Channel closed", Node's text) once the other side is gone.
    pub fn send(&self, msg: &Value) -> Result<(), String> {
        if !self.connected() {
            return Err("Channel closed".into());
        }
        let mut line = serde_json::to_vec(msg).map_err(|e| e.to_string())?;
        line.push(b'\n');
        self.tx.send(line).map_err(|_| "Channel closed".to_string())
    }

    /// Close the channel from this side.
    pub fn disconnect(&self) {
        self.connected.store(false, Ordering::SeqCst);
    }
}

/// Start the reader and writer for one end of the pair (needs a Tokio runtime).
/// Incoming messages arrive on the receiver, in order; it ends when the channel closes.
pub fn open(fd: OwnedFd) -> io::Result<(Sender, mpsc::UnboundedReceiver<Value>)> {
    let std_stream = std::os::unix::net::UnixStream::from(fd);
    std_stream.set_nonblocking(true)?;
    let stream = tokio::net::UnixStream::from_std(std_stream)?;
    let (mut rd, mut wr) = stream.into_split();
    let connected = Arc::new(AtomicBool::new(true));
    let (out_tx, mut out_rx) = mpsc::unbounded_channel::<Vec<u8>>();
    let (in_tx, in_rx) = mpsc::unbounded_channel::<Value>();

    let c = connected.clone();
    tokio::spawn(async move {
        while let Some(line) = out_rx.recv().await {
            if !c.load(Ordering::SeqCst) || wr.write_all(&line).await.is_err() {
                c.store(false, Ordering::SeqCst);
                break;
            }
        }
        let _ = wr.shutdown().await;
    });

    let c = connected.clone();
    tokio::spawn(async move {
        let mut buf = vec![0u8; 65536];
        let mut line: Vec<u8> = Vec::new();
        let mut skipping = false;
        loop {
            let n = match rd.read(&mut buf).await {
                Ok(0) | Err(_) => break,
                Ok(n) => n,
            };
            let mut rest = &buf[..n];
            while let Some(i) = rest.iter().position(|&b| b == b'\n') {
                if !skipping {
                    line.extend_from_slice(&rest[..i]);
                    if line.len() <= MAX_LINE {
                        if let Ok(v) = serde_json::from_slice::<Value>(&line) {
                            if in_tx.send(v).is_err() {
                                // nobody listens any more; keep draining
                            }
                        }
                    }
                }
                line.clear();
                skipping = false;
                rest = &rest[i + 1..];
            }
            if !skipping {
                line.extend_from_slice(rest);
                if line.len() > MAX_LINE {
                    line.clear();
                    skipping = true;
                }
            }
            if !c.load(Ordering::SeqCst) {
                break;
            }
        }
        c.store(false, Ordering::SeqCst);
    });
    Ok((Sender { tx: out_tx, connected }, in_rx))
}

/// In the app: take the end the supervisor handed over (`SENTRY_SUPERVISOR_FD`),
/// check that it is a socket and keep it from ffmpeg and other children
/// (close-on-exec). The variable is removed so children do not see it, as Node
/// removes NODE_CHANNEL_FD; call this before starting threads.
pub fn take_from_env() -> Option<OwnedFd> {
    let v = std::env::var(FD_ENV).ok()?;
    std::env::remove_var(FD_ENV);
    let fd: i32 = v.parse().ok().filter(|n| *n >= 0)?;
    // SAFETY: fstat/fcntl on a number only inspect it
    unsafe {
        let mut st: libc::stat = std::mem::zeroed();
        if libc::fstat(fd, &mut st) != 0 || (st.st_mode & libc::S_IFMT) != libc::S_IFSOCK {
            return None;
        }
        let flags = libc::fcntl(fd, libc::F_GETFD);
        if flags < 0 || libc::fcntl(fd, libc::F_SETFD, flags | libc::FD_CLOEXEC) != 0 {
            return None;
        }
        Some(OwnedFd::from_raw_fd(fd))
    }
}

/// For the supervisor's `pre_exec`: put `fd` at `CHILD_FD`, inheritable.
///
/// # Safety
/// Only async-signal-safe calls; for use between fork and exec.
pub unsafe fn install_child_fd(fd: i32) -> io::Result<()> {
    if fd == CHILD_FD {
        let flags = libc::fcntl(fd, libc::F_GETFD);
        if flags < 0 || libc::fcntl(fd, libc::F_SETFD, flags & !libc::FD_CLOEXEC) != 0 {
            return Err(io::Error::last_os_error());
        }
    } else if libc::dup2(fd, CHILD_FD) < 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}

pub fn raw(fd: &OwnedFd) -> i32 {
    fd.as_raw_fd()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[tokio::test]
    async fn json_lines_both_ways_and_disconnect() {
        let (a, b) = socketpair().unwrap();
        let (sa, mut ra) = open(a).unwrap();
        let (sb, mut rb) = open(b).unwrap();
        sa.send(&json!({ "type": "x", "text": "a\nb" })).unwrap();
        sa.send(&json!({ "type": "y" })).unwrap();
        assert_eq!(rb.recv().await.unwrap(), json!({ "type": "x", "text": "a\nb" }));
        assert_eq!(rb.recv().await.unwrap(), json!({ "type": "y" }));
        sb.send(&json!({ "type": "z" })).unwrap();
        assert_eq!(ra.recv().await.unwrap()["type"], "z");
        drop(sb);
        drop(rb);
        // the other side gone: the reader ends and sending fails
        sb_gone(&sa, &mut ra).await;
    }

    async fn sb_gone(sa: &Sender, ra: &mut mpsc::UnboundedReceiver<Value>) {
        // the writer task of b holds the socket until its sender is dropped
        let _ = tokio::time::timeout(std::time::Duration::from_secs(5), ra.recv()).await;
        for _ in 0..50 {
            if !sa.connected() {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        }
        assert!(!sa.connected());
        assert_eq!(sa.send(&json!({})).unwrap_err(), "Channel closed");
    }

    #[tokio::test]
    async fn garbage_and_overlong_lines_are_dropped() {
        let (a, b) = socketpair().unwrap();
        let (_sb, mut rb) = open(b).unwrap();
        // a plain blocking writer on its own thread (more than the socket buffer holds)
        let writer = std::thread::spawn(move || {
            let mut raw = std::os::unix::net::UnixStream::from(a);
            use std::io::Write;
            raw.write_all(b"not json\n").unwrap();
            let mut long = vec![b'"'; 1];
            long.extend(std::iter::repeat_n(b'a', MAX_LINE + 10));
            long.extend_from_slice(b"\"\n{\"type\":\"ok\"}\n");
            raw.write_all(&long).unwrap();
            raw
        });
        assert_eq!(rb.recv().await.unwrap(), json!({ "type": "ok" }));
        drop(writer.join().unwrap());
    }
}
