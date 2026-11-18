//! A port of `server/proc.js`: run a command without a shell, collect its
//! output, kill it with SIGKILL after a timeout. Never fails: errors are in
//! the result.

use std::io;
use std::process::Stdio;
use std::time::Duration;
use tokio::io::AsyncReadExt;

#[derive(Debug, Clone, Default)]
pub struct RunResult {
    /// The exit code; -1 when killed by a signal or when it could not start.
    pub code: i32,
    pub stdout: String,
    pub stderr: String,
    pub timed_out: bool,
    /// Why it could not start (`error.code` in Node; `NotFound` is ENOENT).
    pub error: Option<io::ErrorKind>,
    pub signal: Option<i32>,
}

pub const MAX_OUTPUT: usize = 4 * 1024 * 1024;

async fn collect<R: tokio::io::AsyncRead + Unpin>(r: Option<R>, max: usize) -> Vec<u8> {
    let mut out = Vec::new();
    let Some(mut r) = r else { return out };
    let mut buf = [0u8; 16384];
    loop {
        match r.read(&mut buf).await {
            Ok(0) | Err(_) => break,
            // as in Node: a chunk is added while the total is under the limit
            Ok(n) => {
                if out.len() < max {
                    out.extend_from_slice(&buf[..n]);
                }
            }
        }
    }
    out
}

/// `run(cmd, args, { timeoutMs, maxOutput })`.
pub async fn run(cmd: &str, args: &[String], timeout: Duration, max_output: usize) -> RunResult {
    let mut c = tokio::process::Command::new(cmd);
    c.args(args).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped()).kill_on_drop(true);
    let mut child = match c.spawn() {
        Ok(ch) => ch,
        Err(e) => return RunResult { code: -1, error: Some(e.kind()), ..Default::default() },
    };
    let out = tokio::spawn(collect(child.stdout.take(), max_output));
    let err = tokio::spawn(collect(child.stderr.take(), max_output));
    let mut timed_out = false;
    let status = match tokio::time::timeout(timeout, child.wait()).await {
        Ok(s) => s,
        Err(_) => {
            timed_out = true;
            let _ = child.start_kill();
            child.wait().await
        }
    };
    // 'close': the process has ended and its output is closed
    let stdout = String::from_utf8_lossy(&out.await.unwrap_or_default()).into_owned();
    let stderr = String::from_utf8_lossy(&err.await.unwrap_or_default()).into_owned();
    match status {
        Ok(st) => {
            use std::os::unix::process::ExitStatusExt;
            RunResult { code: st.code().unwrap_or(-1), stdout, stderr, timed_out, error: None, signal: st.signal() }
        }
        Err(e) => RunResult { code: -1, stdout, stderr, timed_out, error: Some(e.kind()), signal: None },
    }
}

/// Remove ffmpeg's "[h264_nvenc @ 0x55bc...]" context prefixes (`/\[[^\]]* @ 0x[0-9a-f]+\]\s*/gi`).
fn strip_contexts(line: &str) -> String {
    let b = line.as_bytes();
    let mut out = String::with_capacity(line.len());
    let mut i = 0;
    let mut copied = 0;
    while i < b.len() {
        if b[i] == b'[' {
            if let Some(rel) = line[i + 1..].find(']') {
                let j = i + 1 + rel;
                let inner = &line[i + 1..j];
                let ok = inner.rfind(" @ 0").is_some_and(|k| {
                    let after = &inner[k + 4..];
                    let mut it = after.chars();
                    matches!(it.next(), Some('x' | 'X')) && {
                        let hex = it.as_str();
                        !hex.is_empty() && hex.bytes().all(|c| c.is_ascii_hexdigit())
                    }
                });
                if ok {
                    out.push_str(&line[copied..i]);
                    let mut end = j + 1;
                    while let Some(c) = line[end..].chars().next() {
                        if super::js::is_js_ws(c) {
                            end += c.len_utf8();
                        } else {
                            break;
                        }
                    }
                    copied = end;
                    i = end;
                    continue;
                }
            }
        }
        i += line[i..].chars().next().map_or(1, char::len_utf8);
    }
    out.push_str(&line[copied..]);
    out
}

pub fn clean_lines(text: &str) -> Vec<String> {
    text.split('\n')
        .map(|l| super::js::js_trim(&strip_contexts(l)).to_string())
        .filter(|l| !l.is_empty())
        .collect()
}

/// Last few meaningful lines, for error messages (`tail`).
pub fn tail(text: &str, lines: usize) -> String {
    let all = clean_lines(text);
    all[all.len().saturating_sub(lines)..].join(" | ")
}

/// First few lines (`head`).
pub fn head(text: &str, lines: usize) -> String {
    clean_lines(text).into_iter().take(lines).collect::<Vec<_>>().join(" | ")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tail_and_head_clean_lines() {
        let t = "[h264_nvenc @ 0x55bcAF] first\n\n  [x] keep [a @ 0xzz] \nlast [hevc @ 0X1f]  one\n";
        assert_eq!(clean_lines(t), ["first", "[x] keep [a @ 0xzz]", "last one"]);
        assert_eq!(tail(t, 2), "[x] keep [a @ 0xzz] | last one");
        assert_eq!(head(t, 1), "first");
        assert_eq!(tail("", 2), "");
    }

    #[tokio::test]
    async fn runs_without_a_shell_and_times_out() {
        let r = run("sh", &["-c".into(), "echo out; echo err >&2; exit 3".into()], Duration::from_secs(10), MAX_OUTPUT).await;
        assert_eq!((r.code, r.stdout.as_str(), r.stderr.as_str(), r.timed_out), (3, "out\n", "err\n", false));
        let r = run("sleep", &["5".into()], Duration::from_millis(100), MAX_OUTPUT).await;
        assert!(r.timed_out);
        assert_eq!(r.code, -1);
        let r = run("/nonexistent/mount", &[], Duration::from_secs(1), MAX_OUTPUT).await;
        assert_eq!((r.code, r.error), (-1, Some(io::ErrorKind::NotFound)));
    }
}
