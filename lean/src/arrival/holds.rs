//! Sentry USB's `holds` (server/sentryUsb.js interpret, inRange, holds): a
//! clip is held while the share's `.sentryusb/archive-status.json` says
//! "transferring" and the clip's name is in the transfer's first..last clip
//! range (by name, as the Pi sorts). The status file itself is read by the
//! Sentry USB link (the can/ area); this is the rule on what it holds, from
//! the parts of the file it needs, parsed as parseStatus does.

use serde_json::Value;

/// The transfer part of a parsed status (parseStatus: state, transfer).
#[derive(Clone, Debug, Default, PartialEq)]
pub struct TransferStatus {
    pub transferring: bool,
    /// transfer present (an object, not an array)
    pub has_transfer: bool,
    pub first_clip: Option<String>,
    pub last_clip: Option<String>,
    pub give_up_unix: Option<u64>,
}

/// `text(v, 512)`: a string of at most 1024 UTF-16 units, control characters dropped, cut to 512.
fn text(v: Option<&Value>, max: usize) -> Option<String> {
    let s = v?.as_str()?;
    if s.encode_utf16().count() > 1024 {
        return None;
    }
    let clean: String = s.chars().filter(|c| !(('\u{0}'..='\u{1f}').contains(c) || *c == '\u{7f}')).collect();
    Some(crate::viewer::js::slice_units(&clean, max))
}

/// relpath(v): a relative path from the share root, or None.
fn relpath(v: Option<&Value>) -> Option<String> {
    let s = text(v, 512)?;
    if s.is_empty() || s.starts_with('/') || s.split('/').any(|p| p == ".." || p.is_empty()) {
        return None;
    }
    Some(s)
}

/// int(v): a non-negative safe integer
fn int(v: Option<&Value>) -> Option<u64> {
    let n = v?.as_f64()?;
    (n.fract() == 0.0 && (0.0..=9_007_199_254_740_991.0).contains(&n)).then_some(n as u64)
}

impl TransferStatus {
    /// From the status file's JSON; None when it is not a schema 1 status.
    pub fn parse(raw: &Value) -> Option<TransferStatus> {
        let o = raw.as_object()?;
        if o.get("schema").and_then(Value::as_f64) != Some(1.0) {
            return None;
        }
        let t = o.get("transfer").and_then(Value::as_object);
        Some(TransferStatus {
            transferring: o.get("state").and_then(Value::as_str) == Some("transferring"),
            has_transfer: t.is_some(),
            first_clip: t.and_then(|t| relpath(t.get("first_clip"))),
            last_clip: t.and_then(|t| relpath(t.get("last_clip"))),
            give_up_unix: t.and_then(|t| int(t.get("give_up_unix"))),
        })
    }
}

/// interpret(status).range: { first, last } clip names still arriving.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Range {
    pub first: String,
    pub last: String,
}

fn clip_name(rel: Option<&String>) -> Option<String> {
    rel.map(|r| r.rsplit('/').next().unwrap_or("").to_string()).filter(|s| !s.is_empty())
}

/// interpret(status, nowMs): (transferring, overdue, range)
pub fn interpret(status: Option<&TransferStatus>, now_ms: f64) -> (bool, bool, Option<Range>) {
    let Some(s) = status else { return (false, false, None) };
    let overdue = s.transferring && s.has_transfer && s.give_up_unix.is_some_and(|g| now_ms / 1000.0 > g as f64);
    let mut range = None;
    if s.transferring && s.has_transfer {
        let first = clip_name(s.first_clip.as_ref());
        let last = clip_name(s.last_clip.as_ref()).or_else(|| first.clone());
        if let (Some(first), Some(last)) = (first, last) {
            range = Some(if super::js::js_cmp(&first, &last).is_le() { Range { first, last } } else { Range { first: last, last: first } });
        }
    }
    (s.transferring, overdue, range)
}

/// inRange(range, name)
pub fn in_range(range: Option<&Range>, name: &str) -> bool {
    let Some(r) = range else { return false };
    !name.is_empty() && super::js::js_cmp(name, &r.first).is_ge() && super::js::js_cmp(name, &r.last).is_le()
}

/// holds(abs) for a clip of a vehicle whose status is `status`: still arriving.
pub fn holds(status: Option<&TransferStatus>, now_ms: f64, abs: &str) -> bool {
    let (transferring, _, range) = interpret(status, now_ms);
    transferring && in_range(range.as_ref(), super::js::basename(abs))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn transferring(start: u64) -> Value {
        json!({ "schema": 1, "state": "transferring", "transfer": { "started_unix": start, "files": 42, "bytes": 1.2e9,
            "first_clip": "SentryClips/2026-11-08_13-05-00/2026-11-08_13-00-00-front.mp4",
            "last_clip": "RecentClips/2026-11-08/2026-11-08_13-30-00-back.mp4",
            "expected_finish_unix": start + 600, "give_up_unix": start + 1500 } })
    }

    // test/sentryUsb.test.js 'status: the transferring range by clip name, overdue past give_up_unix'
    #[test]
    fn range_by_clip_name() {
        let start = 1_794_144_660u64; // Date.UTC(2026, 10, 8, 13, 31) / 1000
        let s = TransferStatus::parse(&transferring(start)).unwrap();
        let (t, overdue, range) = interpret(Some(&s), (start + 60) as f64 * 1000.0);
        assert!(t && !overdue);
        assert_eq!(range, Some(Range { first: "2026-11-08_13-00-00-front.mp4".into(), last: "2026-11-08_13-30-00-back.mp4".into() }));
        assert!(in_range(range.as_ref(), "2026-11-08_13-15-00-left_repeater.mp4"));
        assert!(in_range(range.as_ref(), "2026-11-08_13-30-00-back.mp4") && !in_range(range.as_ref(), "2026-11-08_13-30-00-front.mp4"));
        assert!(!in_range(range.as_ref(), "2026-11-08_12-59-00-front.mp4"));
        assert!(interpret(Some(&s), (start + 1501) as f64 * 1000.0).1);
        assert!(holds(Some(&s), 0.0, "/share/RecentClips/2026-11-08/2026-11-08_13-10-00-front.mp4"));
        assert!(!holds(Some(&s), 0.0, "/share/RecentClips/2026-11-08/2026-11-08_12-10-00-front.mp4"));
        let idle = TransferStatus::parse(&json!({ "schema": 1, "state": "idle" })).unwrap();
        assert!(!holds(Some(&idle), 0.0, "/share/RecentClips/2026-11-08/2026-11-08_13-10-00-front.mp4"));
        assert!(!holds(None, 0.0, "/x/2026-11-08_13-10-00-front.mp4"));
        assert_eq!(TransferStatus::parse(&json!({ "schema": 2 })), None);
        assert_eq!(TransferStatus::parse(&json!([])), None);
        let odd = TransferStatus::parse(&json!({ "schema": 1, "state": "transferring", "transfer": { "first_clip": "../../etc/passwd" } })).unwrap();
        assert_eq!(interpret(Some(&odd), 0.0).2, None);
    }
}
