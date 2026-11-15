//! The app log and the audit log (server/log.js): one line per entry,
//! `2026-11-15T19:18:19.123Z WARN  [audit] Sign-in failed for "x" from 10.0.0.2`,
//! kept in memory (the last 1000) and in `DATA/logs/manager.log` (one previous
//! file, `.1`, past 5 MB), archived to `logs/archive/manager-<time>.log` on
//! Clear, searchable by time, level and text. Secrets in a line are masked.

use regex::Regex;
use serde_json::{json, Value};
use std::collections::VecDeque;
use std::io::{BufRead, Read, Seek, Write};
use std::os::unix::fs::{DirBuilderExt, OpenOptionsExt};
use std::path::{Path, PathBuf};
use std::sync::{Arc, LazyLock, Mutex};

pub fn level_num(l: &str) -> u8 {
    match l {
        "debug" => 10,
        "info" => 20,
        "warn" => 30,
        "error" => 40,
        _ => 0,
    }
}

static SECRET: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r#"(?i)(?-u:\b)(pass(?:word)?|pwd|secret|token|cookie|authorization)(\s*[=:]\s*)("[^"]*"|'[^']*'|[^\s,;&]+)"#).unwrap());
static URL_CREDENTIALS: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)((?-u:\b)[a-z][a-z0-9+.-]*://)[^/\s:@]+:[^/\s@]+@").unwrap());
static LINE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^(\d{4}-\d{2}-\d{2}T[\d:.]+Z) (DEBUG|INFO|WARN|ERROR)\s* \[([^\]]{1,40})\] (.*)$").unwrap());
static ARCHIVE_NAME: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^manager-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z\.log$").unwrap());
static CONTROL: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"[\x00-\x08\x0b-\x1f\x7f-\u{9f}]").unwrap());

/// Mask anything that looks like a secret (mount options, URLs with credentials).
pub fn redact(text: &str) -> String {
    let a = SECRET.replace_all(text, "$1$2***");
    URL_CREDENTIALS.replace_all(&a, "$1***@").into_owned()
}

/// Date.prototype.toISOString
pub fn iso(ms: i64) -> String {
    chrono::DateTime::from_timestamp_millis(ms)
        .map(|d| d.format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string())
        .unwrap_or_else(|| "Invalid Date".into())
}

/// Date.parse of an ISO stamp (the forms toISOString and date inputs make), as ms.
pub fn parse_iso(s: &str) -> Option<i64> {
    if let Ok(d) = chrono::DateTime::parse_from_rfc3339(s) {
        return Some(d.timestamp_millis());
    }
    for f in ["%Y-%m-%dT%H:%M:%S%.fZ", "%Y-%m-%dT%H:%M:%SZ", "%Y-%m-%dT%H:%MZ"] {
        if let Ok(d) = chrono::NaiveDateTime::parse_from_str(s, f) {
            return Some(d.and_utc().timestamp_millis());
        }
    }
    if let Ok(d) = chrono::NaiveDate::parse_from_str(s, "%Y-%m-%d") {
        return Some(d.and_hms_opt(0, 0, 0)?.and_utc().timestamp_millis());
    }
    // a date and time without a zone is local time in Date.parse
    for f in ["%Y-%m-%dT%H:%M:%S%.f", "%Y-%m-%dT%H:%M:%S", "%Y-%m-%dT%H:%M"] {
        if let Ok(d) = chrono::NaiveDateTime::parse_from_str(s, f) {
            use chrono::TimeZone;
            return chrono::Local.from_local_datetime(&d).earliest().map(|x| x.timestamp_millis());
        }
    }
    None
}

#[derive(Debug, Clone, PartialEq)]
pub struct Entry {
    pub at: i64,
    pub level: String,
    pub scope: String,
    pub message: String,
}

impl Entry {
    pub fn to_json(&self) -> Value {
        json!({ "at": self.at, "level": self.level, "scope": self.scope, "message": self.message })
    }
    pub fn line(&self) -> String {
        format!("{} {:<5} [{}] {}", iso(self.at), self.level.to_uppercase(), self.scope, self.message)
    }
}

struct Inner {
    lines: VecDeque<Entry>,
    file_bytes: u64,
}

type Listener = Box<dyn Fn(&Entry) + Send + Sync>;

pub struct Logger {
    min: u8,
    keep: usize,
    silent: bool,
    file: Option<PathBuf>,
    max_bytes: u64,
    inner: Mutex<Inner>,
    listeners: Mutex<Vec<Listener>>,
}

/// One scope of a logger: `log.scope("audit").warn(...)`.
#[derive(Clone)]
pub struct Scope {
    logger: Arc<Logger>,
    name: String,
}

/// Where a part that runs in either process logs to: a scope of the app's log,
/// or the supervisor's log (its console and the app's Logs).
#[derive(Clone)]
pub struct LogTo(Arc<dyn Fn(&'static str, String) + Send + Sync>);

impl LogTo {
    pub fn new(f: impl Fn(&'static str, String) + Send + Sync + 'static) -> LogTo {
        LogTo(Arc::new(f))
    }
    pub fn info(&self, m: impl Into<String>) {
        (self.0)("info", m.into());
    }
    pub fn warn(&self, m: impl Into<String>) {
        (self.0)("warn", m.into());
    }
    pub fn error(&self, m: impl Into<String>) {
        (self.0)("error", m.into());
    }
}

impl From<Scope> for LogTo {
    fn from(s: Scope) -> LogTo {
        LogTo::new(move |level, m| s.logger.write(level, &s.name, &m, true))
    }
}

impl Scope {
    pub fn debug(&self, m: impl AsRef<str>) {
        self.logger.write("debug", &self.name, m.as_ref(), true);
    }
    pub fn info(&self, m: impl AsRef<str>) {
        self.logger.write("info", &self.name, m.as_ref(), true);
    }
    pub fn warn(&self, m: impl AsRef<str>) {
        self.logger.write("warn", &self.name, m.as_ref(), true);
    }
    pub fn error(&self, m: impl AsRef<str>) {
        self.logger.write("error", &self.name, m.as_ref(), true);
    }
    pub fn logger(&self) -> &Arc<Logger> {
        &self.logger
    }
}

/// JS list.slice(-n) with JavaScript's conversions of n (it may be negative or fractional).
pub fn js_tail<T: Clone>(list: &[T], n: f64) -> Vec<T> {
    let len = list.len() as f64;
    let start = -n.trunc();
    let s = if start.is_nan() { 0.0 } else if start < 0.0 { (len + start).max(0.0) } else { start.min(len) };
    list[s as usize..].to_vec()
}

#[derive(Debug, Clone, Default)]
pub struct Search {
    pub from: Option<i64>,
    pub to: Option<i64>,
    pub text: String,
    pub min_level: String,
    pub limit: usize,
}

impl Logger {
    pub fn new(level: &str, file: Option<PathBuf>) -> Arc<Logger> {
        Logger::with(level, 1000, false, file, 5 * 1024 * 1024)
    }

    pub fn with(level: &str, keep: usize, silent: bool, file: Option<PathBuf>, max_bytes: u64) -> Arc<Logger> {
        let min = match level_num(level) {
            0 => 20,
            n => n,
        };
        let mut file_bytes = 0;
        if let Some(f) = &file {
            if let Some(d) = f.parent() {
                let _ = std::fs::create_dir_all(d);
            }
            file_bytes = std::fs::metadata(f).map(|m| m.len()).unwrap_or(0);
        }
        let log = Logger { min, keep, silent, file, max_bytes, inner: Mutex::new(Inner { lines: VecDeque::new(), file_bytes }), listeners: Mutex::new(Vec::new()) };
        if log.file.is_some() {
            log.load_tail(256 * 1024);
        }
        Arc::new(log)
    }

    pub fn scope(self: &Arc<Self>, name: &str) -> Scope {
        Scope { logger: self.clone(), name: name.to_string() }
    }

    /// Called for every line written (log.js emits 'line').
    pub fn on_line(&self, f: impl Fn(&Entry) + Send + Sync + 'static) {
        self.listeners.lock().unwrap().push(Box::new(f));
    }

    /// After a restart the Logs still show what happened before it.
    fn load_tail(&self, bytes: u64) {
        let Some(file) = &self.file else { return };
        let mut inner = self.inner.lock().unwrap();
        let Ok(mut f) = std::fs::File::open(file) else { return };
        let start = inner.file_bytes.saturating_sub(bytes);
        let mut buf = Vec::new();
        if f.seek(std::io::SeekFrom::Start(start)).is_err() || f.take(inner.file_bytes - start).read_to_end(&mut buf).is_err() {
            return;
        }
        let text = String::from_utf8_lossy(&buf);
        for raw in text.split('\n') {
            if let Some(e) = parse_line(raw) {
                inner.lines.push_back(e);
            }
        }
        while inner.lines.len() > self.keep {
            inner.lines.pop_front();
        }
    }

    /// One entry is one line: text from outside cannot add lines that look like others.
    pub fn write(&self, level: &str, scope: &str, message: &str, echo: bool) {
        if level_num(level) < self.min {
            return;
        }
        let flat = message.replace("\r\n", " ⏎ ").replace('\n', " ⏎ ");
        let flat = CONTROL.replace_all(&flat, " ");
        let entry = Entry { at: super::db::now_ms(), level: level.to_string(), scope: scope.to_string(), message: redact(&flat) };
        let line = entry.line();
        {
            let mut inner = self.inner.lock().unwrap();
            inner.lines.push_back(entry.clone());
            while inner.lines.len() > self.keep {
                inner.lines.pop_front();
            }
            if !self.silent && echo {
                if level == "error" || level == "warn" {
                    eprintln!("{line}");
                } else {
                    println!("{line}");
                }
            }
            self.append(&mut inner, &line);
        }
        for l in self.listeners.lock().unwrap().iter() {
            l(&entry);
        }
    }

    /// Written straight away, so the last lines before a crash are in the file too.
    fn append(&self, inner: &mut Inner, line: &str) {
        let Some(file) = &self.file else { return };
        let data = format!("{line}\n");
        // (data.length in Node: UTF-16 units)
        if inner.file_bytes + data.encode_utf16().count() as u64 > self.max_bytes {
            if std::fs::rename(file, format!("{}.1", file.display())).is_err() {
                return;
            }
            inner.file_bytes = 0;
        }
        let ok = std::fs::OpenOptions::new().create(true).append(true).mode(0o600).open(file).and_then(|mut f| f.write_all(data.as_bytes()));
        if ok.is_ok() {
            inner.file_bytes += data.len() as u64;
        }
    }

    pub fn file(&self) -> Option<&Path> {
        self.file.as_deref()
    }

    pub fn archive_dir(&self) -> Option<PathBuf> {
        self.file.as_ref().and_then(|f| f.parent()).map(|d| d.join("archive"))
    }

    /// Clear without losing: the kept files move into logs/archive/ as one file. Its name, or None.
    pub fn archive(&self) -> std::io::Result<Option<String>> {
        let mut inner = self.inner.lock().unwrap();
        inner.lines.clear();
        let Some(file) = self.file.clone() else { return Ok(None) };
        let older = PathBuf::from(format!("{}.1", file.display()));
        let parts: Vec<Vec<u8>> = [&older, &file].iter().filter_map(|f| std::fs::read(f).ok()).filter(|b| !b.is_empty()).collect();
        let mut name = None;
        if !parts.is_empty() {
            let dir = self.archive_dir().unwrap();
            std::fs::DirBuilder::new().recursive(true).mode(0o700).create(&dir)?;
            let stamp = iso(super::db::now_ms()).replace([':', '.'], "-");
            let n = format!("manager-{stamp}.log");
            // never over an existing file
            let mut f = std::fs::OpenOptions::new().write(true).create_new(true).mode(0o600).open(dir.join(&n))?;
            for p in &parts {
                f.write_all(p)?;
            }
            name = Some(n);
        }
        for f in [&older, &file] {
            let _ = std::fs::remove_file(f);
        }
        inner.file_bytes = 0;
        Ok(name)
    }

    /// The archived logs, newest first: { name, bytes, at }.
    pub fn archives(&self) -> Vec<Value> {
        let Some(dir) = self.archive_dir() else { return Vec::new() };
        let Ok(rd) = std::fs::read_dir(&dir) else { return Vec::new() };
        let mut out: Vec<(String, u64, f64)> = rd
            .filter_map(Result::ok)
            .filter_map(|e| {
                let name = e.file_name().to_string_lossy().into_owned();
                if !ARCHIVE_NAME.is_match(&name) {
                    return None;
                }
                let md = std::fs::symlink_metadata(dir.join(&name)).ok()?;
                if !md.is_file() {
                    return None;
                }
                let at = md.modified().ok()?.duration_since(std::time::UNIX_EPOCH).ok()?.as_secs_f64() * 1000.0;
                Some((name, md.len(), at))
            })
            .collect();
        out.sort_by(|a, b| b.0.cmp(&a.0));
        out.into_iter().map(|(name, bytes, at)| json!({ "name": name, "bytes": bytes, "at": super::http::num(at) })).collect()
    }

    /// One archived log's text (only names archive() makes, never through a link).
    pub fn archive_text(&self, name: &str) -> Option<String> {
        let dir = self.archive_dir()?;
        if !ARCHIVE_NAME.is_match(name) {
            return None;
        }
        let mut f = std::fs::OpenOptions::new().read(true).custom_flags(libc::O_NOFOLLOW).open(dir.join(name)).ok()?;
        let mut buf = Vec::new();
        f.read_to_end(&mut buf).ok()?;
        Some(String::from_utf8_lossy(&buf).into_owned())
    }

    /// The last lines at or above a level (log.js recent; `limit` as JavaScript's slice(-limit)).
    pub fn recent(&self, limit: f64, min_level: &str) -> Vec<Entry> {
        let min = level_num(min_level);
        let inner = self.inner.lock().unwrap();
        let list: Vec<Entry> = inner.lines.iter().filter(|e| level_num(&e.level) >= min).cloned().collect();
        js_tail(&list, limit)
    }

    /// Log lines by time, level and text, oldest first (the newest `limit`), from the kept and archived files.
    pub fn search(&self, q: &Search) -> Vec<Entry> {
        let min = level_num(&q.min_level);
        let needle = q.text.to_lowercase();
        let mut files: Vec<(PathBuf, bool)> = Vec::new();
        if let Some(dir) = self.archive_dir() {
            let mut a = self.archives();
            a.reverse();
            for x in a {
                let at = x["at"].as_f64().unwrap_or(0.0);
                if q.from.is_none_or(|f| at >= f as f64) {
                    files.push((dir.join(x["name"].as_str().unwrap_or("")), true));
                }
            }
        }
        if let Some(f) = &self.file {
            files.push((PathBuf::from(format!("{}.1", f.display())), false));
            files.push((f.clone(), false));
        }
        let limit = q.limit.max(1);
        let mut out: Vec<Entry> = Vec::new();
        for (file, no_follow) in files {
            let mut o = std::fs::OpenOptions::new();
            o.read(true);
            if no_follow {
                o.custom_flags(libc::O_NOFOLLOW);
            }
            let Ok(f) = o.open(&file) else { continue };
            for raw in std::io::BufReader::new(f).split(b'\n') {
                let Ok(raw) = raw else { break };
                let raw = String::from_utf8_lossy(&raw);
                let raw = raw.strip_suffix('\r').unwrap_or(&raw);
                let Some(e) = parse_line(raw) else { continue };
                if q.from.is_some_and(|f| e.at < f) || q.to.is_some_and(|t| e.at > t) {
                    continue;
                }
                if level_num(&e.level) < min {
                    continue;
                }
                if !needle.is_empty() && !format!("{} {}", e.scope, e.message).to_lowercase().contains(&needle) {
                    continue;
                }
                out.push(e);
                if out.len() >= limit * 2 {
                    out = out.split_off(out.len() - limit);
                }
            }
        }
        out.sort_by_key(|e| e.at);
        if out.len() > limit {
            out = out.split_off(out.len() - limit);
        }
        out
    }

    /// The kept file(s), oldest first, for download.
    pub fn file_text(&self) -> String {
        let Some(f) = &self.file else { return String::new() };
        let a = std::fs::read(format!("{}.1", f.display())).unwrap_or_default();
        let b = std::fs::read(f).unwrap_or_default();
        format!("{}{}", String::from_utf8_lossy(&a), String::from_utf8_lossy(&b))
    }
}

fn parse_line(raw: &str) -> Option<Entry> {
    let m = LINE.captures(raw)?;
    Some(Entry { at: parse_iso(&m[1])?, level: m[2].to_lowercase(), scope: m[3].to_string(), message: m[4].to_string() })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("lean-log-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn masks_secrets() {
        assert_eq!(redact("mount -o username=bob,password=hunter2,vers=3"), "mount -o username=bob,password=***,vers=3");
        assert_eq!(redact("token: \"abc def\" next"), "token: *** next");
        assert_eq!(redact("smb://bob:hunter2@nas/share"), "smb://***@nas/share");
        assert_eq!(redact("Authorization=Bearer"), "Authorization=***");
    }

    #[test]
    fn one_line_per_entry_and_file_format() {
        let d = tmp("line");
        let f = d.join("logs").join("manager.log");
        let log = Logger::with("info", 1000, true, Some(f.clone()), 5 * 1024 * 1024);
        log.scope("audit").warn("Sign-in failed for \"x\ny\" from 10.0.0.2\u{7}");
        log.scope("server").debug("hidden");
        let text = std::fs::read_to_string(&f).unwrap();
        let re = Regex::new(r#"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z WARN  \[audit\] Sign-in failed for "x ⏎ y" from 10\.0\.0\.2 \n$"#).unwrap();
        assert!(re.is_match(&text), "{text:?}");
        // read back after a restart
        let again = Logger::with("info", 1000, true, Some(f), 5 * 1024 * 1024);
        assert_eq!(again.recent(100.0, "debug").len(), 1);
    }

    #[test]
    fn rotation_archive_and_search() {
        let d = tmp("rot");
        let f = d.join("manager.log");
        let log = Logger::with("debug", 1000, true, Some(f.clone()), 300);
        for i in 0..10 {
            log.scope("s").info(format!("line {i} with some padding to fill the file"));
        }
        assert!(PathBuf::from(format!("{}.1", f.display())).exists());
        assert_eq!(log.recent(3.0, "debug").len(), 3);
        assert_eq!(log.recent(-5.0, "debug").len(), 5);
        let found = log.search(&Search { text: "LINE 9".into(), min_level: "info".into(), limit: 2000, ..Default::default() });
        assert_eq!(found.len(), 1);
        let name = log.archive().unwrap().unwrap();
        assert!(ARCHIVE_NAME.is_match(&name));
        assert!(!f.exists());
        assert_eq!(log.archives().len(), 1);
        assert!(log.archive_text(&name).unwrap().contains("line 9"));
        assert!(log.archive_text("../manager.log").is_none());
        // (one previous file is kept: the archive holds the last few lines; the newest two are asked for)
        let all = log.search(&Search { min_level: "debug".into(), limit: 2, ..Default::default() });
        assert_eq!(all.len(), 2);
        assert!(all[1].message.starts_with("line 9"));
    }
}
