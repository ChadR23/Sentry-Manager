//! server/converterHost.js start(): the converter opened once (kept across
//! attempts, as the lifecycle's retainRuntime does) and started with
//! retries: attempt i waits delay x i before the next, the last failure is
//! the answer. The desktop app shows a recovery dialog instead.

use super::ctx::ConverterCtx;
use super::error::{CError, CResult};
use super::runtime::Converter;
use std::sync::{Arc, Mutex};
use std::time::Duration;

pub struct Host {
    runtime: Mutex<Option<Arc<Converter>>>,
    last_error: Mutex<Option<CError>>,
}

impl Default for Host {
    fn default() -> Self {
        Host { runtime: Mutex::new(None), last_error: Mutex::new(None) }
    }
}

fn code_or_message(e: &CError) -> String {
    if e.code.is_empty() {
        e.message.clone()
    } else {
        e.code.clone()
    }
}

impl Host {
    /// start({ attempts = 5, delayMs = 2000 }): `open` makes the converter
    /// (only until one is made); its start() recovers unfinished jobs
    pub fn start(&self, open: &dyn Fn() -> CResult<Converter>, ctx: &dyn ConverterCtx, attempts: u32, delay: Duration) -> CResult<Arc<Converter>> {
        let mut i = 1;
        loop {
            let r = (|| -> CResult<Arc<Converter>> {
                let existing = self.runtime.lock().unwrap().clone();
                let rt = match existing {
                    Some(rt) => rt,
                    None => {
                        let rt = Arc::new(open()?);
                        *self.runtime.lock().unwrap() = Some(rt.clone());
                        rt
                    }
                };
                rt.start()?;
                Ok(rt)
            })();
            match r {
                Ok(rt) => {
                    *self.last_error.lock().unwrap() = None;
                    let caps = rt.staging.capabilities();
                    ctx.log_info(&format!("Converter ready (replacement {}, cleanup {})", caps["replacement"].as_str().unwrap_or("unavailable"), caps["ownershipCleanup"].as_str().unwrap_or("unavailable")));
                    return Ok(rt);
                }
                Err(e) => {
                    ctx.log_error(&format!("Converter start attempt {i} failed: {}", code_or_message(&e)));
                    *self.last_error.lock().unwrap() = Some(e.clone());
                    if i >= attempts {
                        return Err(e);
                    }
                    std::thread::sleep(delay * i);
                    i += 1;
                }
            }
        }
    }

    pub fn runtime(&self) -> Option<Arc<Converter>> {
        self.runtime.lock().unwrap().clone()
    }

    pub fn last_error(&self) -> Option<CError> {
        self.last_error.lock().unwrap().clone()
    }

    /// stop(): the lifecycle's beforeQuit (shutdown, errors logged)
    pub fn stop(&self) {
        if let Some(rt) = self.runtime() {
            rt.shutdown();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    struct Log(Mutex<Vec<String>>);
    impl ConverterCtx for Log {
        fn data_path(&self) -> std::path::PathBuf {
            "/".into()
        }
        fn temp_path(&self) -> std::path::PathBuf {
            "/".into()
        }
        fn resolve_path(&self, _p: &str, _m: bool) -> Option<String> {
            None
        }
        fn log_error(&self, l: &str) {
            self.0.lock().unwrap().push(l.into());
        }
        fn log_info(&self, l: &str) {
            self.0.lock().unwrap().push(l.into());
        }
    }

    #[test]
    fn start_retries_keep_the_converter_and_report_each_attempt() {
        let d = super::super::testutil::tempdir().unwrap();
        for n in ["data", "temp"] {
            std::fs::create_dir_all(d.path().join(n)).unwrap();
        }
        let log = Log(Mutex::new(vec![]));
        let opened = AtomicUsize::new(0);
        let fails = AtomicUsize::new(2);
        let host = Host::default();
        let (data, temp) = (d.path().join("data"), d.path().join("temp"));
        let open = || {
            opened.fetch_add(1, Ordering::SeqCst);
            if fails.load(Ordering::SeqCst) > 0 {
                fails.fetch_sub(1, Ordering::SeqCst);
                return Err(CError::code("EIO"));
            }
            let mut o = super::super::runtime::RuntimeOptions::new(data.clone(), temp.clone(), "ffmpeg", "ffprobe");
            o.auto_timer = false;
            Converter::open(o)
        };
        let rt = host.start(&open, &log, 5, Duration::from_millis(1)).unwrap();
        assert_eq!(opened.load(Ordering::SeqCst), 3);
        let lines = log.0.lock().unwrap().clone();
        assert_eq!(&lines[..2], &["Converter start attempt 1 failed: EIO", "Converter start attempt 2 failed: EIO"]);
        assert!(lines[2].starts_with("Converter ready (replacement "), "{}", lines[2]);
        assert!(host.last_error().is_none());
        // started again: the same converter, nothing opened
        let again = host.start(&open, &log, 5, Duration::from_millis(1)).unwrap();
        assert!(Arc::ptr_eq(&rt, &again));
        assert_eq!(opened.load(Ordering::SeqCst), 3);
        host.stop();
        // every attempt failing: the last error is the answer
        let host = Host::default();
        let never = || -> CResult<Converter> { Err(CError::code("RECOVERY_FAILED")) };
        assert_eq!(host.start(&never, &log, 3, Duration::from_millis(1)).err().map(|e| e.code).as_deref(), Some("RECOVERY_FAILED"));
        assert_eq!(host.last_error().unwrap().code, "RECOVERY_FAILED");
    }

    #[test]
    fn empty_verification_folders_go_while_idle_and_nothing_else() {
        let d = super::super::testutil::tempdir().unwrap();
        for n in ["data", "temp"] {
            std::fs::create_dir_all(d.path().join(n)).unwrap();
        }
        let temp = std::fs::canonicalize(d.path().join("temp")).unwrap();
        let old = std::time::SystemTime::now() - Duration::from_secs(120);
        let make = |name: &str, file: bool, aged: bool| {
            let p = temp.join(name);
            std::fs::create_dir_all(&p).unwrap();
            if file {
                std::fs::write(p.join("clip.mp4"), "x").unwrap();
            }
            if aged {
                std::fs::File::open(&p).unwrap().set_modified(old).unwrap();
            }
            p
        };
        let mut o = super::super::runtime::RuntimeOptions::new(d.path().join("data"), temp.clone(), "ffmpeg", "ffprobe");
        o.auto_timer = false;
        let c = Converter::open(o).unwrap();
        let empty_old = make("sentry-six-verification-a", false, true);
        let full_old = make("sentry-six-verification-b", true, true);
        let empty_new = make("sentry-six-verification-c", false, false);
        let other = make("other-folder", false, true);
        super::super::runtime::sweep_empty_snapshot_folders(&c.service, &super::super::runtime::Bench::default(), &temp);
        assert!(!empty_old.exists(), "an empty folder older than a minute goes");
        assert!(full_old.exists() && empty_new.exists() && other.exists(), "one with a file, one in use now, and other folders stay");
    }
}
