//! runtime.js createBoundedProcessRunner: ffmpeg / ffprobe as child
//! processes, never through a shell, with a time limit, an output limit and
//! cancellation; SIGTERM ends them as in Node, and SIGKILL what is still there
//! a grace later, or once the child itself ended (each runs in its own process
//! group, so what it started goes with it), so a run ends within its limit plus
//! about two graces.

use std::io::Read;
use std::os::unix::process::CommandExt;
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
    /// after SIGTERM, how long before SIGKILL; after SIGKILL, how long it is waited for (a
    /// process stuck on a dead share may not end even then: it is reaped when it does); and
    /// how long the output is waited for once it ended
    pub grace_ms: u64,
}

impl BoundedRunner {
    /// the server's runner (converterHost): HOST_PROCESS_TIMEOUT_MS by default
    pub fn host() -> BoundedRunner {
        BoundedRunner { timeout_ms: HOST_PROCESS_TIMEOUT_MS, ..Default::default() }
    }
}

impl Default for BoundedRunner {
    fn default() -> Self {
        BoundedRunner { timeout_ms: 30_000, max_output_bytes: 1024 * 1024, grace_ms: 5_000 }
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
        cmd.args(args).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped()).process_group(0);
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
        let group = Group { pid, done: Arc::new(Mutex::new(false)) };
        let reader_group = group.clone();
        let term = move || reader_group.signal(libc::SIGTERM);
        let mut readers = Vec::new();
        for (is_out, stream) in [(true, child.stdout.take().map(|s| Box::new(s) as Box<dyn Read + Send>)), (false, child.stderr.take().map(|s| Box::new(s) as Box<dyn Read + Send>))] {
            let Some(mut stream) = stream else { continue };
            let cap = cap.clone();
            let term = term.clone();
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
        let grace = Duration::from_millis(self.grace_ms);
        let (mut timed_out, mut aborted) = (false, false);
        let (mut termed, mut killed): (Option<Instant>, Option<Instant>) = (None, None);
        // (its end is seen without reaping it: until it is reaped its pid, the group's id, is not
        // given to another process, so a signal to the group cannot reach another one)
        let stuck = loop {
            // (looked at under the gate every signal takes: a child reaped by someone else closes
            // it before another signal can go out)
            let end = {
                let mut done = group.done.lock().unwrap();
                let end = ended(pid);
                if end == End::Gone {
                    *done = true;
                }
                end
            };
            if end != End::Running {
                break false;
            }
            if termed.is_none() && start.elapsed() >= Duration::from_millis(timeout) {
                timed_out = true;
                termed = Some(Instant::now());
                term();
            }
            if termed.is_none() && opts.cancel.as_ref().is_some_and(|c| c.load(Ordering::SeqCst)) {
                aborted = true;
                termed = Some(Instant::now());
                term();
            }
            // (over the output limit a reader sent SIGTERM)
            if termed.is_none() && cap.lock().unwrap().exceeded {
                termed = Some(Instant::now());
            }
            match (termed, killed) {
                (Some(t), None) if t.elapsed() >= grace => {
                    group.signal(libc::SIGKILL);
                    killed = Some(Instant::now());
                }
                // (stuck where even SIGKILL waits, on a dead share: not waited for)
                (_, Some(k)) if k.elapsed() >= grace => break true,
                _ => {}
            }
            std::thread::sleep(Duration::from_millis(10));
        };
        // the output ends when everything holding its pipes did (a stuck child holds them as long
        // as it is stuck: not waited for); what the child started and left running is killed a
        // drain later, and a reader still blocked after that is left to end
        if !stuck {
            let drain = grace.max(Duration::from_secs(1));
            let waited = |until: Instant| {
                while readers.iter().any(|r| !r.is_finished()) && Instant::now() < until {
                    std::thread::sleep(Duration::from_millis(10));
                }
            };
            waited(Instant::now() + drain);
            if readers.iter().any(|r| !r.is_finished()) && killed.is_none() {
                group.signal(libc::SIGKILL);
                killed = Some(Instant::now());
                waited(Instant::now() + drain);
            }
            // a run that was ended (its limit, a cancel, its output limit, also one passed while
            // the output was drained) takes its whole group with it: what the child started gets
            // SIGKILL even when it holds no pipe of ours (the child is not reaped yet, so its
            // group's id is still ours)
            if killed.is_none() && (termed.is_some() || cap.lock().unwrap().exceeded) {
                group.signal(libc::SIGKILL);
            }
        }
        // no signal from here on: once reaped, the group's id may be another process's
        *group.done.lock().unwrap() = true;
        let status = if stuck {
            std::thread::spawn(move || {
                let _ = child.wait();
            });
            None
        } else {
            child.wait().ok()
        };
        for r in readers.into_iter().filter(|r| r.is_finished()) {
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

/// The process group a child leads (its pid), signalled until `done`: the run sets it before it
/// reaps the child, whose pid, the group's id, may then be given to another process. The run must
/// be the only one that reaps its child (nothing in the server ignores SIGCHLD or waits for any
/// child): one reaped elsewhere is seen as gone and closes the gate, but a signal sent before that
/// could reach a reused id, and what it started can no longer be killed with its group.
#[derive(Clone)]
struct Group {
    pid: i32,
    done: Arc<Mutex<bool>>,
}

impl Group {
    fn signal(&self, sig: i32) {
        let done = self.done.lock().unwrap();
        if !*done {
            // SAFETY: signalling the process group of our own child, not yet reaped
            unsafe {
                libc::kill(-self.pid, sig);
            }
        }
    }
}

#[derive(Debug, PartialEq)]
enum End {
    Running,
    /// ended and not reaped yet: its pid, the group's id, is still ours
    Exited,
    /// not ours to wait for any more (ECHILD): reaped by someone else, its id may be reused
    Gone,
}

/// Whether the child ended, leaving it to be reaped (waitid WNOWAIT). After an error other than
/// ECHILD it has not, and the run's limit and graces still bound the wait.
fn ended(pid: i32) -> End {
    loop {
        // SAFETY: an all-zero siginfo_t is valid; waitid only writes into it
        let mut info: libc::siginfo_t = unsafe { std::mem::zeroed() };
        let r = unsafe { libc::waitid(libc::P_PID, pid as libc::id_t, &mut info, libc::WEXITED | libc::WNOHANG | libc::WNOWAIT) };
        if r == 0 {
            return if unsafe { info.si_pid() } != 0 { End::Exited } else { End::Running };
        }
        match std::io::Error::last_os_error().raw_os_error() {
            Some(libc::EINTR) => continue,
            Some(libc::ECHILD) => return End::Gone,
            _ => return End::Running,
        }
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
        let r = BoundedRunner { timeout_ms: 5_000, max_output_bytes: 1000, ..Default::default() };
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

    #[test]
    fn a_child_that_ignores_sigterm_is_killed_a_grace_later() {
        let r = BoundedRunner { grace_ms: 300, ..Default::default() };
        let t = Instant::now();
        // (an ignored signal stays ignored in what the shell starts)
        let out = r.run("sh", &s(&["-c", "trap '' TERM; sleep 30"]), &RunOptions { timeout_ms: Some(100), ..Default::default() }).unwrap();
        assert!(out.timed_out && out.status.is_none() && out.signal.as_deref() == Some("SIGKILL"), "{out:?}");
        assert!(t.elapsed() < Duration::from_secs(5), "{:?}", t.elapsed());
    }

    /// What a run's child starts in the background: it ignores SIGTERM, writes nowhere the run
    /// reads and records its pid. Killed (if it is still that sleep) and removed when the test
    /// ends, however it ends.
    struct Leftover {
        dir: std::path::PathBuf,
    }

    impl Leftover {
        fn new(name: &str) -> Leftover {
            let dir = std::env::temp_dir().join(format!("lean-proc-{name}-{}", std::process::id()));
            let _ = std::fs::remove_dir_all(&dir);
            std::fs::create_dir_all(&dir).unwrap();
            Leftover { dir }
        }
        fn pid_file(&self) -> std::path::PathBuf {
            self.dir.join("pid")
        }
        /// shell text that starts it and goes on once it is that sleep (its trap set, its pid recorded)
        fn start(&self) -> String {
            let p = self.pid_file().display().to_string();
            format!("sh -c 'trap \"\" TERM; echo $$ > {p}.tmp && mv {p}.tmp {p}; exec sleep 30' >/dev/null 2>&1 & while [ ! -s {p} ] || [ \"$(cat /proc/$(cat {p})/comm 2>/dev/null)\" != sleep ]; do sleep 0.01; done; ")
        }
        fn pid(&self) -> Option<i32> {
            Self::pid_in(&self.pid_file())
        }
        fn pid_in(file: &std::path::Path) -> Option<i32> {
            std::fs::read_to_string(file).ok()?.trim().parse().ok()
        }
        /// its /proc stat after the command name: the state first
        fn state(pid: i32) -> Option<String> {
            let st = std::fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
            Some(st.rsplit_once(')')?.1.trim_start().to_string())
        }
        fn running(pid: i32) -> bool {
            let is_sleep = std::fs::read_to_string(format!("/proc/{pid}/comm")).is_ok_and(|c| c.trim() == "sleep");
            is_sleep && Self::state(pid).is_some_and(|s| !s.starts_with('Z'))
        }
        /// gone (or dead, not reaped yet by whoever it was handed to) within 3 s
        fn gone(&self) -> bool {
            let pid = self.pid().expect("the background process recorded its pid");
            let until = Instant::now() + Duration::from_secs(3);
            while Self::running(pid) && Instant::now() < until {
                std::thread::sleep(Duration::from_millis(20));
            }
            !Self::running(pid)
        }
    }

    impl Drop for Leftover {
        fn drop(&mut self) {
            if let Some(pid) = self.pid().filter(|&p| Self::running(p)) {
                // SAFETY: the test's own leftover sleep, still running
                unsafe {
                    libc::kill(pid, libc::SIGKILL);
                }
            }
            let _ = std::fs::remove_dir_all(&self.dir);
        }
    }

    #[test]
    fn what_a_cancelled_run_started_is_killed_with_it_even_when_it_holds_no_pipe() {
        let left = Leftover::new("cancelled");
        let r = BoundedRunner::default();
        // (cancelled once the background process is that sleep; the shell dies on SIGTERM)
        let cancel = Arc::new(AtomicBool::new(false));
        let (c2, pid_file) = (cancel.clone(), left.pid_file());
        std::thread::spawn(move || {
            let until = Instant::now() + Duration::from_secs(10);
            while !Leftover::pid_in(&pid_file).is_some_and(Leftover::running) && Instant::now() < until {
                std::thread::sleep(Duration::from_millis(10));
            }
            c2.store(true, Ordering::SeqCst);
        });
        let out = r.run("sh", &s(&["-c", &format!("{}sleep 30", left.start())]), &RunOptions { cancel: Some(cancel), ..Default::default() }).unwrap();
        assert!(out.aborted && out.signal.as_deref() == Some("SIGTERM"), "{out:?}");
        assert!(left.gone(), "what the cancelled shell started is still running");
    }

    #[test]
    fn what_a_run_started_is_killed_when_its_output_passes_the_limit_after_it_ended() {
        let left = Leftover::new("limit");
        let r = BoundedRunner { max_output_bytes: 1000, ..Default::default() };
        // (the shell ends at once; what it left behind passes the output limit while the output
        // is drained, then ends on the SIGTERM that brings)
        let script = format!("{}(sleep 0.3; head -c 5000 /dev/zero; sleep 30) &", left.start());
        let out = r.run("sh", &s(&["-c", &script]), &RunOptions::default()).unwrap();
        assert!(out.output_limit_exceeded && out.status == Some(0), "{out:?}");
        assert!(left.gone(), "what the shell started is still running after its output passed the limit");
    }

    #[test]
    fn what_a_child_left_running_does_not_hold_the_run() {
        let r = BoundedRunner { grace_ms: 300, ..Default::default() };
        let t = Instant::now();
        // (the shell ends at once; the sleep it left holds the output pipes)
        let out = r.run("sh", &s(&["-c", "echo started; sleep 30 &"]), &RunOptions::default()).unwrap();
        assert_eq!((out.status, out.stdout.as_str(), out.timed_out), (Some(0), "started\n", false));
        assert!(t.elapsed() < Duration::from_secs(5), "{:?}", t.elapsed());
    }

    #[test]
    fn with_no_grace_the_whole_output_still_comes() {
        let r = BoundedRunner { grace_ms: 0, max_output_bytes: 1 << 20, ..Default::default() };
        let out = r.run("sh", &s(&["-c", "head -c 200000 /dev/zero | tr '\\0' a"]), &RunOptions::default()).unwrap();
        assert_eq!((out.status, out.stdout.len()), (Some(0), 200_000));
    }

    #[test]
    fn a_process_in_its_own_session_holding_the_pipes_is_left_to_end_on_its_own() {
        if !std::path::Path::new("/usr/bin/setsid").exists() && !std::path::Path::new("/bin/setsid").exists() {
            return;
        }
        let r = BoundedRunner { grace_ms: 300, ..Default::default() };
        let t = Instant::now();
        // (out of the child's group, so no signal of the run reaches it)
        let out = r.run("sh", &s(&["-c", "setsid sleep 30 & echo started"]), &RunOptions::default()).unwrap();
        assert_eq!((out.status, out.stdout.as_str()), (Some(0), "started\n"));
        assert!(t.elapsed() < Duration::from_secs(5), "{:?}", t.elapsed());
    }
}
