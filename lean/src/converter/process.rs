//! runtime.js createBoundedProcessRunner: ffmpeg / ffprobe as child
//! processes, never through a shell, with a time limit, an output limit and
//! cancellation; SIGTERM ends them as in Node.

use std::io::Read;
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

#[derive(Debug, Clone, Default, PartialEq)]
pub struct ProcResult {
    /// None when it ended by a signal or never started
    pub status: Option<i32>,
    pub signal: Option<String>,
    pub stdout: String,
    pub stderr: String,
    pub timed_out: bool,
    pub aborted: bool,
    pub output_limit_exceeded: bool,
    /// { code: 'PROCESS_START_FAILED' }
    pub error: Option<String>,
}

/// What the verifier, planner and probes run commands with (tests stand in their own).
pub trait Runner: Send + Sync {
    fn run(&self, command: &str, args: &[String], opts: &RunOptions) -> Result<ProcResult, String>;
}

#[derive(Default, Clone)]
pub struct RunOptions {
    pub timeout_ms: Option<u64>,
    pub cancel: Option<Arc<AtomicBool>>,
    pub cwd: Option<std::path::PathBuf>,
}

/// server/converterHost.js processTimeoutMs: a probe, verify or telemetry
/// run still going after 30 minutes is stuck (calls that name their own
/// limit keep it: the encoder probes, the inspection, nvidia-smi)
pub const HOST_PROCESS_TIMEOUT_MS: u64 = 30 * 60_000;

pub struct BoundedRunner {
    pub timeout_ms: u64,
    pub max_output_bytes: usize,
}

impl BoundedRunner {
    /// the server's runner (converterHost): HOST_PROCESS_TIMEOUT_MS by default
    pub fn host() -> BoundedRunner {
        BoundedRunner { timeout_ms: HOST_PROCESS_TIMEOUT_MS, ..Default::default() }
    }
}

impl Default for BoundedRunner {
    fn default() -> Self {
        BoundedRunner { timeout_ms: 30_000, max_output_bytes: 1024 * 1024 }
    }
}

/// validateProcessRequest
pub fn validate_request(command: &str, args: &[String]) -> Result<(), String> {
    if command.is_empty() || command.len() > 32_768 || command.contains('\0') || args.len() > 1_024 || args.iter().any(|a| a.len() > 32_768 || a.contains('\0')) {
        return Err("INVALID_PROCESS_REQUEST".into());
    }
    Ok(())
}

/// cudaOrderOptions: GPUs picked by index are numbered in PCI order.
pub fn cuda_by_index(args: &[String]) -> bool {
    args.iter().enumerate().any(|(i, a)| {
        (a == "-gpu" || a == "-hwaccel_device") && args.get(i + 1).is_some_and(|n| !n.is_empty() && n.bytes().all(|b| b.is_ascii_digit()))
    })
}

struct Captured {
    stdout: Vec<u8>,
    stderr: Vec<u8>,
    total: usize,
    exceeded: bool,
}

impl Runner for BoundedRunner {
    fn run(&self, command: &str, args: &[String], opts: &RunOptions) -> Result<ProcResult, String> {
        validate_request(command, args)?;
        let timeout = opts.timeout_ms.filter(|&t| t > 0).unwrap_or(self.timeout_ms);
        if opts.cancel.as_ref().is_some_and(|c| c.load(Ordering::SeqCst)) {
            return Ok(ProcResult { status: None, signal: Some("SIGTERM".into()), aborted: true, ..Default::default() });
        }
        let mut cmd = Command::new(command);
        cmd.args(args).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
        if let Some(d) = &opts.cwd {
            cmd.current_dir(d);
        }
        if cuda_by_index(args) {
            cmd.env("CUDA_DEVICE_ORDER", "PCI_BUS_ID");
        }
        let mut child = match cmd.spawn() {
            Ok(c) => c,
            Err(_) => return Ok(ProcResult { error: Some("PROCESS_START_FAILED".into()), ..Default::default() }),
        };
        let pid = child.id() as i32;
        let cap = Arc::new(Mutex::new(Captured { stdout: vec![], stderr: vec![], total: 0, exceeded: false }));
        let max = self.max_output_bytes;
        let term = move || {
            // SAFETY: signalling our own child by its pid
            unsafe {
                libc::kill(pid, libc::SIGTERM);
            }
        };
        let mut readers = Vec::new();
        for (is_out, stream) in [(true, child.stdout.take().map(|s| Box::new(s) as Box<dyn Read + Send>)), (false, child.stderr.take().map(|s| Box::new(s) as Box<dyn Read + Send>))] {
            let Some(mut stream) = stream else { continue };
            let cap = cap.clone();
            readers.push(std::thread::spawn(move || {
                let mut buf = [0u8; 16384];
                loop {
                    let n = match stream.read(&mut buf) {
                        Ok(0) | Err(_) => break,
                        Ok(n) => n,
                    };
                    let mut c = cap.lock().unwrap();
                    if c.exceeded {
                        continue;
                    }
                    c.total += n;
                    if c.total > max {
                        c.exceeded = true;
                        c.stdout.clear();
                        c.stderr.clear();
                        term();
                        continue;
                    }
                    if is_out {
                        c.stdout.extend_from_slice(&buf[..n]);
                    } else {
                        c.stderr.extend_from_slice(&buf[..n]);
                    }
                }
            }));
        }
        let start = Instant::now();
        let (mut timed_out, mut aborted, mut termed) = (false, false, false);
        let status = loop {
            match child.try_wait() {
                Ok(Some(s)) => break Some(s),
                Ok(None) => {}
                Err(_) => break None,
            }
            if !termed && start.elapsed() >= Duration::from_millis(timeout) {
                timed_out = true;
                termed = true;
                term();
            }
            if !termed && opts.cancel.as_ref().is_some_and(|c| c.load(Ordering::SeqCst)) {
                aborted = true;
                termed = true;
                term();
            }
            std::thread::sleep(Duration::from_millis(10));
        };
        for r in readers {
            let _ = r.join();
        }
        let c = cap.lock().unwrap();
        use std::os::unix::process::ExitStatusExt;
        let (code, signal) = match status {
            Some(s) => (s.code(), s.signal().map(signal_name)),
            None => (None, None),
        };
        Ok(ProcResult {
            status: code,
            signal,
            stdout: if c.exceeded { String::new() } else { String::from_utf8_lossy(&c.stdout).into_owned() },
            stderr: if c.exceeded { String::new() } else { String::from_utf8_lossy(&c.stderr).into_owned() },
            timed_out,
            aborted,
            output_limit_exceeded: c.exceeded,
            error: None,
        })
    }
}

fn signal_name(n: i32) -> String {
    match n {
        libc::SIGTERM => "SIGTERM",
        libc::SIGKILL => "SIGKILL",
        libc::SIGINT => "SIGINT",
        libc::SIGSEGV => "SIGSEGV",
        libc::SIGABRT => "SIGABRT",
        _ => "SIGNAL",
    }
    .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn s(v: &[&str]) -> Vec<String> {
        v.iter().map(|x| x.to_string()).collect()
    }

    #[test]
    fn runs_limits_and_cancels() {
        let r = BoundedRunner { timeout_ms: 5_000, max_output_bytes: 1000 };
        let ok = r.run("sh", &s(&["-c", "echo hi; echo err >&2"]), &RunOptions::default()).unwrap();
        assert_eq!((ok.status, ok.stdout.as_str(), ok.stderr.as_str()), (Some(0), "hi\n", "err\n"));
        let t = r.run("sleep", &s(&["5"]), &RunOptions { timeout_ms: Some(100), ..Default::default() }).unwrap();
        assert!(t.timed_out && t.status.is_none() && t.signal.as_deref() == Some("SIGTERM"));
        let big = r.run("sh", &s(&["-c", "head -c 5000 /dev/zero"]), &RunOptions::default()).unwrap();
        assert!(big.output_limit_exceeded && big.stdout.is_empty());
        let missing = r.run("/nonexistent/ffmpeg", &[], &RunOptions::default()).unwrap();
        assert_eq!(missing.error.as_deref(), Some("PROCESS_START_FAILED"));
        let cancel = Arc::new(AtomicBool::new(false));
        let c2 = cancel.clone();
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(100));
            c2.store(true, Ordering::SeqCst);
        });
        let a = r.run("sleep", &s(&["5"]), &RunOptions { cancel: Some(cancel), ..Default::default() }).unwrap();
        assert!(a.aborted);
        assert!(r.run("a\0b", &[], &RunOptions::default()).is_err());
        assert!(cuda_by_index(&s(&["-gpu", "1"])) && !cuda_by_index(&s(&["-gpu", "any"])));
    }
}
