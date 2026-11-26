//! jobStore.js validation: preflightManifest, normalizeManifest and the
//! normalizers of each part, with Node's checks in Node's order and the
//! normalized object's keys in the order Node builds them (so a job file
//! this store writes is byte for byte what Node would write).

use super::super::contracts::{self, GROUPS, TIMING_PHASES};
use super::super::error::CError;
use super::states::{ArtifactState, ItemState, JobState, ReplacementPhase};
use serde_json::{Map, Value};

pub const MANIFEST_VERSION: i64 = 1;
pub const LIMIT_BYTES: u64 = 64 * 1024 * 1024;
pub const LIMIT_ITEMS: usize = 50_000;
pub const LIMIT_PATH: usize = 32_768;
pub const LIMIT_TEXT: usize = 256;
pub const LIMIT_TOKEN: usize = 512;
pub const LIMIT_DEPTH: usize = 16;
pub const LIMIT_NODES: u64 = 2_500_000;
pub const LIMIT_STRING_UNITS: u64 = 32 * 1024 * 1024;
pub const MAX_SAFE: i64 = 9_007_199_254_740_991;

// (JOB_STATES, ITEM_STATES, REPLACEMENT_PHASES and the owned files' states: states.rs)
pub const DEFAULT_GROUP_ORDER: [&str; 3] = ["SavedClips", "SentryClips", "RecentClips"];

pub const TOP_FIELDS: [&str; 24] = [
    "schemaVersion", "id", "state", "revision", "config", "items", "counters", "summary", "summaryDismissed", "discoveryComplete", "createdAt", "updatedAt", "activeItemId", "ownedPaths", "ownedArtifacts",
    "publicationArtifact", "replacementPhase", "recovery", "failure", "timings", "pausedMs", "moreAfter", "permissionBlock", "discoveryIssues",
];
const CONFIG_FIELDS: [&str; 20] = [
    "sourceRoot", "destinationRoot", "codec", "profileId", "networkMode", "outputMode", "includedGroups", "groupOrder", "replacementConfirmed", "concurrency", "bitrateKbps", "qualityLevel", "autoConvert", "verifyMode", "lanes",
    "keepOffTarget", "keepLarger", "resumeAfter", "part", "keepRecent",
];
const ITEM_FIELDS: [&str; 25] = [
    "id", "state", "kind", "group", "eventId", "relativePath", "sourcePath", "sourceBytes", "mtimeMs", "timestampKey", "camera", "assetType", "eligibleVideo", "outputPath", "outputBytes", "attempts", "encoder", "failure",
    "resultCode", "ownedPaths", "ownedArtifacts", "publicationArtifact", "replacementPhase", "expectedSource", "offTarget",
];
const COUNTER_FIELDS: [&str; 6] = ["files", "sourceVideoBytes", "outputVideoBytes", "savedBytes", "copiedAssetBytes", "groups"];
const SUMMARY_FIELDS: [&str; 10] = ["files", "sourceVideoBytes", "outputVideoBytes", "savedBytes", "copiedAssetBytes", "groups", "source", "output", "saved", "copiedAssets"];
const GROUP_COUNTER_FIELDS: [&str; 4] = ["files", "sourceBytes", "outputBytes", "savedBytes"];
pub const OWNED_PATH_FIELDS: [&str; 6] = ["stagedSource", "encodedCandidate", "publicationSnapshot", "destinationPartial", "replacementCandidate", "replacementBackup"];
const PUBLICATION_FIELDS: [&str; 4] = ["path", "token", "sha256", "size"];
const OWNED_ARTIFACT_FIELDS: [&str; 8] = ["path", "nonce", "state", "size", "sha256", "device", "inode", "journal"];
const RECOVERY_FIELDS: [&str; 5] = ["fromState", "phase", "action", "pathRole", "resumeState"];

pub fn message(code: &str) -> &'static str {
    match code {
        "INVALID_JOB_ID" => "The job identifier is invalid.",
        "UNSAFE_JOB_PATH" => "The job manifest path is unsafe.",
        "INVALID_MANIFEST" => "The job manifest schema is invalid.",
        "UNSUPPORTED_MANIFEST_VERSION" => "The job manifest version is not supported.",
        "SENSITIVE_MANIFEST_DATA" => "The job manifest contains data that must not be persisted.",
        "JOB_EXISTS" => "A job with this identifier already exists.",
        "JOB_NOT_FOUND" => "The requested job does not exist.",
        "STALE_MANIFEST_REVISION" => "The job manifest revision is stale.",
        "MANIFEST_READ_FAILED" => "The job manifest could not be read.",
        "MANIFEST_WRITE_FAILED" => "The job manifest could not be saved.",
        "MANIFEST_QUARANTINE_FAILED" => "The corrupt job manifest could not be quarantined.",
        "CORRUPT_MANIFEST" => "The job manifest is corrupt and was quarantined.",
        "INSPECTION_FAILED" => "The interrupted job paths could not be inspected.",
        _ => "The job store operation failed.",
    }
}

/// storeError(code). The refused field's name (never its value), where Node
/// sets `error.field`, is kept in `path`.
pub fn se(code: &str) -> CError {
    CError::new(code, message(code))
}

type R<T> = Result<T, CError>;

pub fn refused(path: &str, rule: impl Into<String>) -> CError {
    let mut e = CError::new("INVALID_MANIFEST", rule);
    if !path.is_empty() { e.path = Some(path.into()); }
    e
}

pub fn at(field: &str, mut e: CError) -> CError {
    e.path = Some(match e.path { Some(p) => format!("{field}.{p}"), None => field.into() });
    e
}

fn invalid<T>(rule: &str) -> R<T> { Err(refused("", rule)) }

pub fn limit(name: &str, actual: u64, maximum: u64) -> R<()> {
    if actual > maximum { return Err(refused(name, format!("value {actual} exceeds limit {maximum}"))); }
    Ok(())
}

// ---- JS value predicates -------------------------------------------------

/// Number.isSafeInteger
pub fn safe_int_of(v: &Value) -> Option<i64> {
    match v {
        Value::Number(n) => {
            if let Some(i) = n.as_i64() {
                if (-MAX_SAFE..=MAX_SAFE).contains(&i) {
                    return Some(i);
                }
                return None;
            }
            if n.as_u64().is_some() {
                return None;
            }
            let f = n.as_f64()?;
            if f.is_finite() && f.fract() == 0.0 && f.abs() <= MAX_SAFE as f64 {
                Some(f as i64)
            } else {
                None
            }
        }
        _ => None,
    }
}

/// A number as JSON.stringify writes it: an integral value is an integer.
pub fn num(f: f64) -> Value {
    if f.is_finite() && f.fract() == 0.0 && f.abs() < 1e21 {
        if f.abs() <= i64::MAX as f64 / 2.0 {
            return Value::from(f as i64);
        }
    }
    serde_json::Number::from_f64(f).map(Value::Number).unwrap_or(Value::Null)
}

/// Numbers in a value read from JSON, written back the way JSON.stringify
/// writes them (an integral double as an integer).
pub fn canonical_number(v: &Value) -> Value {
    match v {
        Value::Number(n) if !n.is_i64() && !n.is_u64() => num(n.as_f64().unwrap_or(0.0)),
        other => other.clone(),
    }
}

/// String.length (UTF-16 code units)
pub fn js_len(s: &str) -> usize {
    s.encode_utf16().count()
}

fn is_plain(v: &Value) -> bool {
    v.is_object()
}

pub fn is_safe_id(s: &str) -> bool {
    // /^[a-z0-9][a-z0-9_-]{0,127}$/
    let b = s.as_bytes();
    !b.is_empty() && b.len() <= 128 && (b[0].is_ascii_lowercase() || b[0].is_ascii_digit()) && b.iter().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || *c == b'_' || *c == b'-')
}

pub fn is_windows_reserved(s: &str) -> bool {
    // /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/
    matches!(s, "con" | "prn" | "aux" | "nul") || (s.len() == 4 && (s.starts_with("com") || s.starts_with("lpt")) && (b'1'..=b'9').contains(&s.as_bytes()[3]))
}

fn safe_code(s: &str) -> bool {
    // /^[a-z0-9][a-z0-9_-]{0,63}$/
    is_safe_id(s) && s.len() <= 64
}

fn hex64(s: &str) -> bool {
    s.len() == 64 && s.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

fn digits(s: &str, max: usize) -> bool {
    !s.is_empty() && s.len() <= max && s.bytes().all(|b| b.is_ascii_digit())
}

/// path.isAbsolute || path.win32.isAbsolute || path.posix.isAbsolute
pub fn any_absolute(s: &str) -> bool {
    let b = s.as_bytes();
    if b.first().is_some_and(|c| *c == b'/' || *c == b'\\') {
        return true;
    }
    b.len() >= 3 && b[0].is_ascii_alphabetic() && b[1] == b':' && (b[2] == b'/' || b[2] == b'\\')
}

pub fn is_sensitive_field(key: &str) -> bool {
    let n: String = key.to_lowercase().chars().filter(|c| c.is_ascii_lowercase() || c.is_ascii_digit()).collect();
    ["payload", "telemetry", "fingerprint", "nal", "password", "secret", "token", "authorization", "cookie", "exception"].iter().any(|w| n.contains(w))
        || ["stack", "cause", "stderr", "stdout", "message", "error", "errors", "diagnostic", "diagnostics"].contains(&n.as_str())
}

/// fieldName(key): what a manifest refused names, never a value.
pub fn field_name(key: &str) -> String {
    let mapped: String = key.encode_utf16().map(|u| {
        let c = char::from_u32(u as u32).unwrap_or('?');
        if c.is_ascii_alphanumeric() || c == '_' || c == '.' || c == '-' { c } else { '?' }
    }).collect();
    mapped.chars().take(64).collect()
}

fn reject_unknown(v: &Value, allowed: &[&str]) -> R<()> {
    let Some(m) = v.as_object() else { return invalid("expected an object") };
    for k in m.keys() {
        if !allowed.contains(&k.as_str()) {
            let mut e = se(if is_sensitive_field(k) { "SENSITIVE_MANIFEST_DATA" } else { "INVALID_MANIFEST" });
            e.path = Some(field_name(k));
            e.message = "field is not allowed".into();
            return Err(e);
        }
    }
    Ok(())
}

pub fn assert_safe_job_id(id: &str) -> R<()> {
    if !is_safe_id(id) || is_windows_reserved(id) {
        return Err(se("INVALID_JOB_ID"));
    }
    Ok(())
}

fn bounded_string(v: &Value, max: usize, pattern: Option<fn(&str) -> bool>) -> R<Value> {
    let Some(s) = v.as_str() else { return invalid("expected string") };
    let len = js_len(s);
    if len == 0 { return invalid("string must be nonempty") }
    limit("string UTF-16 units", len as u64, max as u64)?;
    if !pattern.map_or(true, |p| p(s)) { return invalid("string does not match the permitted field format") }
    Ok(v.clone())
}

fn text(v: &Value) -> R<Value> {
    bounded_string(v, LIMIT_TEXT, None)
}

fn portable_item_id(v: &Value) -> R<Value> {
    let id = bounded_string(v, 128, Some(is_safe_id))?;
    if is_windows_reserved(id.as_str().unwrap()) {
        return invalid("id: reserved filename");
    }
    Ok(id)
}

fn bounded_path(v: &Value, nullable: bool, relative: bool) -> R<Value> {
    if nullable && v.is_null() {
        return Ok(Value::Null);
    }
    bounded_string(v, LIMIT_PATH, None)?;
    let s = v.as_str().unwrap();
    if relative {
        if any_absolute(s) {
            return invalid("path must be relative");
        }
        let norm = s.replace('\\', "/");
        if norm.split('/').any(|c| c.is_empty() || c == "." || c == "..") {
            return invalid("relative path has an empty, dot or parent component");
        }
    } else if !any_absolute(s) {
        return invalid("path must be absolute");
    }
    Ok(v.clone())
}

fn abs_path(v: &Value) -> R<Value> {
    bounded_path(v, false, false)
}

fn safe_integer(v: &Value, positive: bool) -> R<Value> {
    match safe_int_of(v) {
        Some(i) if i >= if positive { 1 } else { 0 } => Ok(Value::from(i)),
        _ => invalid("expected a safe integer with the required sign"),
    }
}

fn signed_integer(v: &Value) -> R<Value> {
    safe_int_of(v).map(Value::from).ok_or_else(|| refused("", "expected a signed safe integer"))
}

fn non_negative_finite(v: &Value) -> R<Value> {
    match v.as_f64() {
        Some(f) if f.is_finite() && f >= 0.0 && f <= MAX_SAFE as f64 => Ok(canonical_number(v)),
        _ => invalid("expected a finite nonnegative number no greater than MAX_SAFE"),
    }
}

fn get<'a>(m: &'a Map<String, Value>, k: &str) -> &'a Value {
    m.get(k).unwrap_or(&Value::Null)
}

/// A field that is absent in the input (JS undefined). serde has no undefined:
/// an absent key reads as this marker so `=== undefined` checks can be told
/// apart from `=== null` ones.
fn present(m: &Map<String, Value>, k: &str) -> bool {
    m.contains_key(k)
}

/// optional(target, source, key, normalize)
fn optional(out: &mut Map<String, Value>, src: &Map<String, Value>, key: &str, f: impl FnOnce(&Value) -> R<Value>) -> R<()> {
    if let Some(v) = src.get(key) {
        if !v.is_null() {
            match f(v) {
                Ok(n) => {
                    out.insert(key.to_string(), n);
                }
                Err(mut e) => {
                    e.path = Some(match e.path {
                        Some(p) => format!("{}.{}", field_name(key), p),
                        None => field_name(key),
                    });
                    return Err(e);
                }
            }
        }
    }
    Ok(())
}

// ---- preflight -------------------------------------------------------------

/// What preflightManifest measured.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Budget {
    pub nodes: u64,
    pub string_units: u64,
    pub estimated: u64,
}

impl Budget {
    fn check(&self) -> R<()> {
        limit("LIMIT_NODES", self.nodes, LIMIT_NODES)?;
        limit("LIMIT_STRING_UNITS", self.string_units, LIMIT_STRING_UNITS)?;
        limit("LIMIT_BYTES (estimated + nodes * 12)", self.estimated + self.nodes * 12, LIMIT_BYTES)
    }
    pub fn add(&mut self, o: &Budget) -> R<()> {
        self.nodes += o.nodes;
        self.string_units += o.string_units;
        self.estimated += o.estimated;
        self.check()
    }
    fn string(&mut self, s: &str) -> R<()> {
        let mut units = 0u64;
        let mut bytes = s.len() as u64 + 2;
        for u in s.encode_utf16() {
            units += 1;
            match u {
                0x22 | 0x5c | 0x08 | 0x09 | 0x0a | 0x0c | 0x0d => bytes += 1,
                0..=0x1f => bytes += 5,
                _ => {}
            }
        }
        self.string_units += units;
        self.estimated += bytes;
        limit("LIMIT_STRING_UNITS", self.string_units, LIMIT_STRING_UNITS)?;
        limit("LIMIT_BYTES (estimated strings)", self.estimated, LIMIT_BYTES)
    }
    /// One value (and everything in it) at `depth`.
    pub fn walk(&mut self, root: &Value, depth: usize) -> R<()> {
        let mut stack: Vec<(&Value, usize)> = vec![(root, depth)];
        while let Some((v, d)) = stack.pop() {
            self.nodes += 1;
            limit("LIMIT_NODES", self.nodes, LIMIT_NODES)?;
            limit("LIMIT_DEPTH", d as u64, LIMIT_DEPTH as u64)?;
            match v {
                Value::Null | Value::Bool(_) => self.estimated += 5,
                Value::String(s) => self.string(s)?,
                Value::Number(_) => self.estimated += 32,
                Value::Array(a) => {
                    limit("LIMIT_ITEMS", a.len() as u64, LIMIT_ITEMS as u64)?;
                    self.estimated += a.len() as u64 + 2;
                    for x in a.iter().rev() {
                        stack.push((x, d + 1));
                    }
                }
                Value::Object(m) => {
                    self.estimated += m.len() as u64 + 2;
                    for (k, x) in m.iter().rev() {
                        self.string(k)?;
                        stack.push((x, d + 1));
                    }
                }
            }
            self.check()?;
        }
        Ok(())
    }
}

/// preflightManifest(value) for a whole value.
pub fn preflight(v: &Value) -> R<Budget> {
    let mut b = Budget::default();
    b.walk(v, 0)?;
    Ok(b)
}

// ---- parts -------------------------------------------------------------------

fn normalize_failure(v: &Value) -> R<Value> {
    reject_unknown(v, &["code", "retryable"])?;
    let m = v.as_object().unwrap();
    let mut out = Map::new();
    out.insert("code".into(), (bounded_string(get(m, "code"), 64, Some(safe_code))).map_err(|e| at("code", e))?);
    if present(m, "retryable") {
        match m.get("retryable") {
            Some(Value::Bool(b)) => {
                out.insert("retryable".into(), Value::Bool(*b));
            }
            _ => return invalid("retryable: expected boolean"),
        }
    }
    Ok(Value::Object(out))
}

fn normalize_owned_paths(v: &Value) -> R<Value> {
    reject_unknown(v, &OWNED_PATH_FIELDS)?;
    let m = v.as_object().unwrap();
    let mut out = Map::new();
    for k in OWNED_PATH_FIELDS {
        optional(&mut out, m, k, abs_path)?;
    }
    Ok(Value::Object(out))
}

fn identity_part(v: &Value) -> R<Value> {
    if let Some(i) = safe_int_of(v) {
        if i >= 0 {
            return Ok(Value::String(i.to_string()));
        }
    }
    if let Value::String(s) = v {
        if digits(s, 32) {
            return Ok(v.clone());
        }
    }
    invalid("identity: expected a nonnegative safe integer or at most 32 decimal digits")
}

fn sha(v: &Value) -> R<Value> {
    bounded_string(v, 64, Some(hex64))
}

fn normalize_owned_artifacts(v: &Value, owned_paths: Option<&Value>) -> R<Value> {
    reject_unknown(v, &OWNED_PATH_FIELDS)?;
    let mut out = Map::new();
    for (key, meta) in v.as_object().unwrap() {
        let entry = (|| -> R<Value> {
        reject_unknown(meta, &OWNED_ARTIFACT_FIELDS)?;
        let m = meta.as_object().unwrap();
        let mut e = Map::new();
        e.insert("path".into(), (abs_path(get(m, "path"))).map_err(|e| at("path", e))?);
        e.insert("nonce".into(), (bounded_string(get(m, "nonce"), 128, Some(is_safe_id))).map_err(|e| at("nonce", e))?);
        let state = text(get(m, "state")).map_err(|e| at("state", e))?;
        let art = ArtifactState::parse(state.as_str().unwrap());
        e.insert("state".into(), state);
        let recorded = owned_paths.and_then(|p| p.get(key));
        if !art.is_known() || recorded.is_none() || recorded != e.get("path") {
            return invalid("owned artifact state must be known and path must match ownedPaths");
        }
        let id_fields = ["size", "sha256", "device", "inode"];
        let count = id_fields.iter().filter(|f| present(m, f)).count();
        if art == ArtifactState::Intent {
            if count != 0 || present(m, "journal") {
                return invalid("intent artifact must not contain identity or journal");
            }
        } else {
            if count != id_fields.len() {
                return invalid("owned artifact requires size, sha256, device and inode");
            }
            let zero_ok = key == "encodedCandidate" && matches!(art, ArtifactState::Owned | ArtifactState::CleanupPending);
            let size = safe_integer(get(m, "size"), art != ArtifactState::Writing && !zero_ok).map_err(|e| at("size", e))?;
            let size_n = size.as_i64().unwrap();
            e.insert("size".into(), size);
            e.insert("sha256".into(), (sha(get(m, "sha256"))).map_err(|e| at("sha256", e))?);
            e.insert("device".into(), (identity_part(get(m, "device"))).map_err(|e| at("device", e))?);
            e.insert("inode".into(), (identity_part(get(m, "inode"))).map_err(|e| at("inode", e))?);
            if present(m, "journal") {
                let j = get(m, "journal");
                reject_unknown(j, &["committed", "pending"]).map_err(|e| at("journal", e))?;
                let jm = j.as_object().unwrap();
                let boundary = |p: &Value| -> R<Value> {
                    reject_unknown(p, &["size", "sha256"])?;
                    let pm = p.as_object().unwrap();
                    let mut b = Map::new();
                    b.insert("size".into(), (safe_integer(get(pm, "size"), false)).map_err(|e| at("size", e))?);
                    b.insert("sha256".into(), (sha(get(pm, "sha256"))).map_err(|e| at("sha256", e))?);
                    Ok(Value::Object(b))
                };
                let committed = boundary(jm.get("committed").unwrap_or(&Value::Bool(false))).map_err(|e| at("journal.committed", e))?;
                // (pending: undefined is refused by the boundary check, null kept)
                let pending = match jm.get("pending") {
                    Some(Value::Null) => Value::Null,
                    Some(p) => boundary(p).map_err(|e| at("journal.pending", e))?,
                    None => return invalid("journal.pending: required (null or boundary)"),
                };
                let cs = committed["size"].as_i64().unwrap();
                if cs > size_n || pending.get("size").and_then(Value::as_i64).is_some_and(|ps| ps < cs) {
                    return invalid("journal boundaries must satisfy committed <= size and pending >= committed");
                }
                let mut jo = Map::new();
                jo.insert("committed".into(), committed);
                jo.insert("pending".into(), pending);
                e.insert("journal".into(), Value::Object(jo));
            } else if art == ArtifactState::Writing {
                return invalid("writing artifact requires journal");
            }
        }
        Ok(Value::Object(e))
        })().map_err(|e| at(&field_name(key), e))?;
        out.insert(key.clone(), entry);
    }
    Ok(Value::Object(out))
}

fn normalize_publication(v: &Value) -> R<Value> {
    reject_unknown(v, &PUBLICATION_FIELDS)?;
    let m = v.as_object().unwrap();
    let mut out = Map::new();
    out.insert("path".into(), (abs_path(get(m, "path"))).map_err(|e| at("path", e))?);
    out.insert("token".into(), (bounded_string(get(m, "token"), LIMIT_TOKEN, None)).map_err(|e| at("token", e))?);
    out.insert("sha256".into(), (sha(get(m, "sha256"))).map_err(|e| at("sha256", e))?);
    out.insert("size".into(), (safe_integer(get(m, "size"), true)).map_err(|e| at("size", e))?);
    Ok(Value::Object(out))
}

fn normalize_group_counters(v: &Value) -> R<Value> {
    reject_unknown(v, &GROUP_COUNTER_FIELDS)?;
    let m = v.as_object().unwrap();
    let mut out = Map::new();
    for k in GROUP_COUNTER_FIELDS {
        let x = (if k == "savedBytes" { signed_integer(get(m, k)) } else { safe_integer(get(m, k), false) }).map_err(|e| at(k, e))?;
        out.insert(k.into(), x);
    }
    let n = |k: &str| out[k].as_i64().unwrap();
    if n("savedBytes") != n("sourceBytes") - n("outputBytes") {
        return invalid("savedBytes must equal sourceBytes - outputBytes");
    }
    Ok(Value::Object(out))
}

fn normalize_counters(v: &Value, allowed: &[&str]) -> R<Map<String, Value>> {
    reject_unknown(v, allowed)?;
    let m = v.as_object().unwrap();
    let mut out = Map::new();
    for k in ["files", "sourceVideoBytes", "outputVideoBytes", "savedBytes", "copiedAssetBytes"] {
        let x = (if k == "savedBytes" { signed_integer(get(m, k)) } else { safe_integer(get(m, k), false) }).map_err(|e| at(k, e))?;
        out.insert(k.into(), x);
    }
    let n = |o: &Map<String, Value>, k: &str| o[k].as_i64().unwrap();
    if n(&out, "savedBytes") != n(&out, "sourceVideoBytes") - n(&out, "outputVideoBytes") {
        return invalid("savedBytes must equal sourceVideoBytes - outputVideoBytes");
    }
    let groups = get(m, "groups");
    reject_unknown(groups, &GROUPS).map_err(|e| at("groups", e))?;
    let gm = groups.as_object().unwrap();
    let mut g = Map::new();
    let (mut files, mut sb, mut ob, mut svb) = (0i64, 0i64, 0i64, 0i64);
    for group in GROUPS {
        let c = normalize_group_counters(get(gm, group)).map_err(|e| at(&format!("groups.{group}"), e))?;
        files += c["files"].as_i64().unwrap();
        sb += c["sourceBytes"].as_i64().unwrap();
        ob += c["outputBytes"].as_i64().unwrap();
        svb += c["savedBytes"].as_i64().unwrap();
        g.insert(group.into(), c);
    }
    if files > n(&out, "files") || sb > n(&out, "sourceVideoBytes") || ob > n(&out, "outputVideoBytes") || svb > n(&out, "savedBytes") {
        return invalid("groups: totals must not exceed the job counters");
    }
    out.insert("groups".into(), Value::Object(g));
    Ok(out)
}

fn normalize_summary(v: &Value) -> R<Value> {
    let mut out = normalize_counters(v, &SUMMARY_FIELDS)?;
    let m = v.as_object().unwrap();
    for k in ["source", "output", "saved", "copiedAssets"] {
        out.insert(k.into(), text(get(m, k)).map_err(|e| at(k, e))?);
    }
    Ok(Value::Object(out))
}

fn same_counters(a: &Value, b: &Value) -> bool {
    for k in ["files", "sourceVideoBytes", "outputVideoBytes", "savedBytes", "copiedAssetBytes"] {
        if a[k] != b[k] {
            return false;
        }
    }
    GROUPS.iter().all(|g| GROUP_COUNTER_FIELDS.iter().all(|k| a["groups"][g][k] == b["groups"][g][k]))
}

fn group_list(v: &Value) -> R<Vec<Value>> {
    v.as_array().unwrap().iter().map(text).collect()
}

fn normalize_config(v: &Value) -> R<Value> {
    reject_unknown(v, &CONFIG_FIELDS)?;
    let m = v.as_object().unwrap();
    let mut out = Map::new();
    out.insert("sourceRoot".into(), (abs_path(get(m, "sourceRoot"))).map_err(|e| at("sourceRoot", e))?);
    out.insert("destinationRoot".into(), (bounded_path(get(m, "destinationRoot"), true, false)).map_err(|e| at("destinationRoot", e))?);
    if !m.contains_key("destinationRoot") {
        // undefined is not null: boundedPath(undefined, nullable) refuses it
        return invalid("destinationRoot: required");
    }
    for k in ["codec", "profileId", "networkMode", "outputMode"] {
        out.insert(k.into(), text(get(m, k)).map_err(|e| at(k, e))?);
    }
    out.insert("replacementConfirmed".into(), m.get("replacementConfirmed").cloned().unwrap_or(Value::Null));
    let s = |k: &str| out[k].as_str().unwrap_or("").to_string();
    let (codec, profile_id, network, output) = (s("codec"), s("profileId"), s("networkMode"), s("outputMode"));
    if !["h265", "av1"].contains(&codec.as_str())
        || !["conservative", "balanced", "aggressive", "custom", "quality", "smallest"].contains(&profile_id.as_str())
        || (profile_id == contracts::SMALLEST_PROFILE_ID && codec != "h265")
        || !["auto", "staging", "direct"].contains(&network.as_str())
        || !["separate", "replace"].contains(&output.as_str())
        || !out["replacementConfirmed"].is_boolean()
    {
        return invalid("codec/profileId/networkMode/outputMode/replacementConfirmed: unsupported configuration or type");
    }
    let confirmed = out["replacementConfirmed"].as_bool().unwrap();
    let included = get(m, "includedGroups");
    match included.as_array() {
        Some(a) if !a.is_empty() && a.len() <= GROUPS.len() => {}
        _ => return invalid("includedGroups: expected 1 to 3 groups"),
    }
    let inc = group_list(included).map_err(|e| at("includedGroups", e))?;
    let mut seen = std::collections::HashSet::new();
    if !inc.iter().all(|g| seen.insert(g.as_str().unwrap().to_string())) || inc.iter().any(|g| !GROUPS.contains(&g.as_str().unwrap())) {
        return invalid("includedGroups: expected distinct known groups");
    }
    out.insert("includedGroups".into(), Value::Array(inc));
    let default_order = Value::Array(DEFAULT_GROUP_ORDER.iter().map(|g| Value::from(*g)).collect());
    let order = m.get("groupOrder").unwrap_or(&default_order);
    match order.as_array() {
        Some(a) if a.len() == GROUPS.len() => {}
        _ => return invalid("groupOrder: expected all three groups"),
    }
    let ord = group_list(order).map_err(|e| at("groupOrder", e))?;
    let mut seen = std::collections::HashSet::new();
    if !ord.iter().all(|g| seen.insert(g.as_str().unwrap().to_string())) || ord.iter().any(|g| !GROUPS.contains(&g.as_str().unwrap())) {
        return invalid("groupOrder: expected distinct known groups");
    }
    out.insert("groupOrder".into(), Value::Array(ord));
    if profile_id == "custom" {
        match m.get("bitrateKbps").and_then(safe_int_of) {
            Some(b) if (contracts::CUSTOM_BITRATE_KBPS_MIN..=contracts::CUSTOM_BITRATE_KBPS_MAX).contains(&b) => {
                out.insert("bitrateKbps".into(), Value::from(b));
            }
            _ => return invalid("bitrateKbps: custom profile requires a safe integer in the supported range"),
        }
    } else if present(m, "bitrateKbps") {
        return invalid("bitrateKbps: only valid for custom profile");
    }
    if profile_id == "quality" {
        match m.get("qualityLevel") {
            Some(Value::String(q)) if contracts::QUALITY_LEVELS.contains(&q.as_str()) => {
                out.insert("qualityLevel".into(), Value::String(q.clone()));
            }
            _ => return invalid("qualityLevel: quality profile requires a known level"),
        }
    } else if present(m, "qualityLevel") {
        return invalid("qualityLevel: only valid for quality profile");
    }
    if let Some(vm) = m.get("verifyMode") {
        match vm.as_str() {
            Some(x) if contracts::is_valid_verify_mode(x) => {
                out.insert("verifyMode".into(), vm.clone());
            }
            _ => return invalid("verifyMode: expected quick or full"),
        }
    }
    if let Some(k) = m.get("keepOffTarget") {
        let Some(b) = k.as_bool() else { return invalid("keepOffTarget: expected boolean") };
        if b && contracts::has_size_target(&profile_id) {
            out.insert("keepOffTarget".into(), Value::Bool(true));
        }
    }
    if let Some(k) = m.get("keepLarger") {
        let Some(b) = k.as_bool() else { return invalid("keepLarger: expected boolean") };
        if b && !contracts::has_size_target(&profile_id) {
            out.insert("keepLarger".into(), Value::Bool(true));
        }
    }
    if let Some(k) = m.get("keepRecent") {
        if !super::super::keep_recent::valid(k) {
            return invalid("keepRecent: expected days 1..365 and a supported time zone");
        }
        out.insert("keepRecent".into(), k.clone());
    }
    if let Some(r) = m.get("resumeAfter") {
        if !r.is_null() {
            out.insert("resumeAfter".into(), (bounded_path(r, false, true)).map_err(|e| at("resumeAfter", e))?);
        }
    }
    if let Some(p) = m.get("part") {
        match safe_int_of(p) {
            Some(n) if (1..=100_000).contains(&n) => {
                out.insert("part".into(), Value::from(n));
            }
            _ => return invalid("part: expected a safe integer 1..100000"),
        }
    }
    if let Some(a) = m.get("autoConvert") {
        if a != &Value::Bool(true) {
            return invalid("autoConvert: must be true when present");
        }
        out.insert("autoConvert".into(), Value::Bool(true));
    }
    let lanes = m.get("lanes").and_then(|l| contracts::normalize_lanes(l).ok().flatten());
    if let Some(lanes) = lanes {
        let total = contracts::lanes_total(&lanes);
        out.insert("lanes".into(), lanes);
        out.insert("concurrency".into(), Value::from(total));
    } else if let Some(c) = m.get("concurrency") {
        match safe_int_of(c) {
            Some(n) if (contracts::CONCURRENCY_MIN..=contracts::CONCURRENCY_MAX).contains(&n) => {
                out.insert("concurrency".into(), Value::from(n));
            }
            _ => return invalid("concurrency: expected a safe integer in the supported range"),
        }
    }
    let dest_null = out["destinationRoot"].is_null();
    if output == "separate" {
        if dest_null || confirmed {
            return invalid("destinationRoot/replacementConfirmed: separate output needs a destination and false confirmation");
        }
    } else if !dest_null || !confirmed {
        return invalid("destinationRoot/replacementConfirmed: replace output needs null destination and true confirmation");
    }
    Ok(Value::Object(out))
}

/// normalizeItem
pub fn normalize_item(v: &Value) -> R<Value> {
    reject_unknown(v, &ITEM_FIELDS)?;
    let m = v.as_object().unwrap();
    let failure = match m.get("failure") {
        Some(f) if !f.is_null() => Some(normalize_failure(f).map_err(|e| at("failure", e))?),
        _ => None,
    };
    let mut out = Map::new();
    out.insert("id".into(), (portable_item_id(get(m, "id"))).map_err(|e| at("id", e))?);
    out.insert("state".into(), (text(get(m, "state"))).map_err(|e| at("state", e))?);
    out.insert("kind".into(), (text(get(m, "kind"))).map_err(|e| at("kind", e))?);
    let nullable_text = |k: &str| -> R<Value> {
        match m.get(k) {
            Some(Value::Null) => Ok(Value::Null),
            other => text(other.unwrap_or(&Value::Bool(false))),
        }
    };
    out.insert("group".into(), (nullable_text("group")).map_err(|e| at("group", e))?);
    out.insert("eventId".into(), (nullable_text("eventId")).map_err(|e| at("eventId", e))?);
    out.insert("relativePath".into(), (bounded_path(get(m, "relativePath"), false, true)).map_err(|e| at("relativePath", e))?);
    out.insert("sourcePath".into(), (abs_path(get(m, "sourcePath"))).map_err(|e| at("sourcePath", e))?);
    out.insert("sourceBytes".into(), (safe_integer(get(m, "sourceBytes"), false)).map_err(|e| at("sourceBytes", e))?);
    out.insert("mtimeMs".into(), (non_negative_finite(get(m, "mtimeMs"))).map_err(|e| at("mtimeMs", e))?);
    let state = ItemState::parse(out["state"].as_str().unwrap());
    let kind = out["kind"].as_str().unwrap().to_string();
    if !state.is_known() || !["video", "asset"].contains(&kind.as_str()) || out["group"].as_str().is_some_and(|g| !GROUPS.contains(&g)) {
        return invalid("state/kind/group: expected known item state, video or asset kind and known or null group");
    }
    optional(&mut out, m, "timestampKey", text)?;
    optional(&mut out, m, "camera", text)?;
    optional(&mut out, m, "assetType", text)?;
    if let Some(e) = m.get("eligibleVideo") {
        if !e.is_null() {
            let Some(b) = e.as_bool() else { return invalid("eligibleVideo: expected boolean") };
            out.insert("eligibleVideo".into(), Value::Bool(b));
        }
    }
    optional(&mut out, m, "outputPath", abs_path)?;
    optional(&mut out, m, "outputBytes", |x| safe_integer(x, false))?;
    optional(&mut out, m, "attempts", |x| {
        let a = safe_integer(x, false)?;
        if a.as_i64().unwrap() > 3 {
            return invalid("attempts: maximum is 3");
        }
        Ok(a)
    })?;
    optional(&mut out, m, "encoder", text)?;
    if let Some(note) = m.get("offTarget") {
        if !note.is_object() {
            return invalid("offTarget: expected object");
        }
        reject_unknown(note, &["savedPercent", "targetPercent"]).map_err(|e| at("offTarget", e))?;
        let sp = note.get("savedPercent").and_then(Value::as_f64);
        let tp = note.get("targetPercent").and_then(Value::as_f64);
        match (sp, tp) {
            (Some(s), Some(t)) if s.is_finite() && (0.0..=100.0).contains(&s) && t.is_finite() && t > 0.0 && t <= 100.0 => {
                let mut o = Map::new();
                o.insert("savedPercent".into(), canonical_number(&note["savedPercent"]));
                o.insert("targetPercent".into(), canonical_number(&note["targetPercent"]));
                out.insert("offTarget".into(), Value::Object(o));
            }
            _ => return invalid("offTarget: savedPercent must be 0..100 and targetPercent must be >0..100"),
        }
    }
    optional(&mut out, m, "resultCode", |x| bounded_string(x, 64, Some(safe_code)))?;
    if let Some(f) = failure {
        out.insert("failure".into(), f);
    }
    optional(&mut out, m, "ownedPaths", normalize_owned_paths)?;
    let op = out.get("ownedPaths").cloned();
    optional(&mut out, m, "ownedArtifacts", |x| normalize_owned_artifacts(x, op.as_ref()))?;
    optional(&mut out, m, "publicationArtifact", normalize_publication)?;
    optional(&mut out, m, "expectedSource", |x| {
        reject_unknown(x, &["size", "sha256", "device", "inode"])?;
        let em = x.as_object().unwrap();
        let mut o = Map::new();
        o.insert("size".into(), (safe_integer(get(em, "size"), false)).map_err(|e| at("size", e))?);
        o.insert("sha256".into(), (sha(get(em, "sha256"))).map_err(|e| at("sha256", e))?);
        o.insert("device".into(), (bounded_string(get(em, "device"), 32, Some(|s| digits(s, 32)))).map_err(|e| at("device", e))?);
        o.insert("inode".into(), (bounded_string(get(em, "inode"), 32, Some(|s| digits(s, 32)))).map_err(|e| at("inode", e))?);
        Ok(Value::Object(o))
    })?;
    optional(&mut out, m, "replacementPhase", |x| match x.as_str().and_then(ReplacementPhase::known) {
        Some(_) => Ok(x.clone()),
        None => invalid("expected a known replacement phase"),
    })?;
    let has = |k: &str| out.get(k).is_some_and(|x| x.as_str().is_some_and(|s| !s.is_empty()));
    if kind == "video" && (!has("timestampKey") || !has("camera")) {
        return invalid("timestampKey/camera: required for video");
    }
    if kind == "asset" && !has("assetType") {
        return invalid("assetType: required for asset");
    }
    if state == ItemState::Failed && !out.contains_key("failure") {
        return invalid("failure: required for failed item");
    }
    let folder_wait=state==ItemState::Skipped && out.get("resultCode")==Some(&Value::from("folder-not-writable"))
        && out.get("failure").is_some_and(|f|f["code"]=="folder-not-writable" && f["retryable"]==true);
    if state != ItemState::Failed && out.contains_key("failure") && !folder_wait {
        return invalid("failure: only valid for failed item");
    }
    if state == ItemState::Completed && (!out.contains_key("outputBytes") || !has("outputPath")) {
        return invalid("outputBytes/outputPath: required for completed item");
    }
    check_publication(&out)?;
    Ok(Value::Object(out))
}

fn check_publication(out: &Map<String, Value>) -> R<()> {
    if let Some(p) = out.get("publicationArtifact") {
        if out.get("ownedPaths").and_then(|o| o.get("publicationSnapshot")) != Some(&p["path"]) {
            return invalid("publicationArtifact.path must match ownedPaths.publicationSnapshot");
        }
        let Some(snap) = out.get("ownedArtifacts").and_then(|o| o.get("publicationSnapshot")) else { return invalid("publicationArtifact requires ownedArtifacts.publicationSnapshot") };
        if snap["state"].as_str().and_then(ArtifactState::known) == Some(ArtifactState::Intent) || snap.get("size") != Some(&p["size"]) || snap.get("sha256") != Some(&p["sha256"]) {
            return invalid("publicationArtifact size/sha256 must match a non-intent publicationSnapshot");
        }
    }
    Ok(())
}

const COPY_ACTIONS: [&str; 4] = ["restart-copy", "finalize-copy", "resume-copy", "manual-intervention"];
const ENCODING_ACTIONS: [&str; 3] = ["restart-encoding", "cleanup-and-restart-encoding", "manual-intervention"];

/// REPLACEMENT_ACTIONS_BY_PHASE
fn replacement_action_allowed(phase: &ReplacementPhase, action: &str) -> bool {
    if action == "manual-intervention" {
        return phase.is_known();
    }
    super::super::recovery::phase_actions(phase).is_some_and(|a| a.contains(&action))
}

fn normalize_recovery(v: &Value, manifest: &Map<String, Value>) -> R<Value> {
    reject_unknown(v, &RECOVERY_FIELDS)?;
    let m = v.as_object().unwrap();
    let mut out = Map::new();
    out.insert("fromState".into(), (text(get(m, "fromState"))).map_err(|e| at("fromState", e))?);
    out.insert("action".into(), (text(get(m, "action"))).map_err(|e| at("action", e))?);
    if let Some(p) = m.get("phase") {
        if !p.is_null() {
            match p.as_str().and_then(ReplacementPhase::known) {
                Some(_) => {
                    out.insert("phase".into(), p.clone());
                }
                None => return invalid("phase: expected known replacement phase"),
            }
        }
    }
    if let Some(p) = m.get("pathRole") {
        if !p.is_null() {
            out.insert("pathRole".into(), (text(p)).map_err(|e| at("pathRole", e))?);
        }
    }
    if let Some(p) = m.get("resumeState") {
        if !p.is_null() {
            out.insert("resumeState".into(), (text(p)).map_err(|e| at("resumeState", e))?);
        }
    }
    let state = JobState::parse(manifest["state"].as_str().unwrap_or(""));
    if !state.is_paused() {
        return invalid("recovery: only valid for a paused job");
    }
    let from = JobState::parse(out["fromState"].as_str().unwrap());
    let action = out["action"].as_str().unwrap().to_string();
    let phase = out.get("phase").and_then(Value::as_str).map(ReplacementPhase::parse);
    let manifest_phase = manifest.get("replacementPhase").and_then(Value::as_str).map(ReplacementPhase::parse);
    match from {
        JobState::Encoding => {
            if phase.is_some() || !ENCODING_ACTIONS.contains(&action.as_str()) {
                return invalid("encoding recovery requires a permitted action and no phase");
            }
        }
        JobState::Copying => {
            if phase.is_some() || !COPY_ACTIONS.contains(&action.as_str()) {
                return invalid("copying recovery requires a permitted action and no phase");
            }
        }
        JobState::Replacing => {
            let Some(p) = phase else { return invalid("phase: required for replacement recovery") };
            if manifest_phase.as_ref() != Some(&p) || !replacement_action_allowed(&p, &action) {
                return invalid("phase/action must match the recorded replacement phase and permitted actions");
            }
        }
        JobState::Waiting => {
            let expected = if manifest.get("discoveryComplete") == Some(&Value::Bool(false)) { "resume-discovery" } else { "resume-queue" };
            if action != expected || phase.is_some() || out.contains_key("pathRole") {
                return invalid("waiting recovery action must match discoveryComplete and have no phase or pathRole");
            }
        }
        JobState::Discovering => {
            if action != "resume-discovery" || phase.is_some() || out.contains_key("pathRole") {
                return invalid("discovery recovery requires resume-discovery and no phase or pathRole");
            }
        }
        JobState::PausedNetwork => {
            if !out.contains_key("resumeState") {
                out.insert("resumeState".into(), JobState::Waiting.into());
            }
            let resume = JobState::parse(out["resumeState"].as_str().unwrap());
            let owns = |k: &str| manifest.get("ownedPaths").and_then(|o| o.get(k)).is_some_and(truthy) || manifest.get("ownedArtifacts").and_then(|o| o.get(k)).is_some_and(truthy);
            let replacement_owned = owns("replacementCandidate") || owns("replacementBackup");
            let role = out.get("pathRole").and_then(Value::as_str).unwrap_or("");
            if action != "resume-network" || !["source", "destination", "discovery"].contains(&role) || !resume.resumes_after_network() {
                return invalid("network recovery requires resume-network, known pathRole and resumable state");
            }
            if resume == JobState::Replacing {
                let Some(p) = phase else { return invalid("phase: required when resuming replacement") };
                if manifest_phase.as_ref() != Some(&p) || manifest["config"]["outputMode"] != "replace" {
                    return invalid("phase/outputMode: replacement recovery must match the recorded phase and replace mode");
                }
            } else if phase.is_some() || manifest_phase.is_some() || replacement_owned {
                return invalid("phase/ownedPaths: non-replacement network recovery must not own replacement files");
            }
        }
        _ => return invalid("fromState: not recoverable"),
    }
    Ok(Value::Object(out))
}

/// JS truthiness of a JSON value
pub fn truthy(v: &Value) -> bool {
    match v {
        Value::Null => false,
        Value::Bool(b) => *b,
        Value::Number(n) => n.as_f64().is_some_and(|f| f != 0.0 && !f.is_nan()),
        Value::String(s) => !s.is_empty(),
        _ => true,
    }
}

fn normalize_timings(v: &Value) -> R<Value> {
    if !is_plain(v) {
        return invalid("expected timings object");
    }
    reject_unknown(v, &["files", "totalMs"])?;
    let total = get(v.as_object().unwrap(), "totalMs");
    if !is_plain(total) {
        return invalid("totalMs: expected object");
    }
    reject_unknown(total, &TIMING_PHASES).map_err(|e| at("totalMs", e))?;
    let tm = total.as_object().unwrap();
    let mut t = Map::new();
    for phase in TIMING_PHASES {
        let x = match tm.get(phase) {
            None => Value::from(0),
            Some(x) => safe_integer(x, false).map_err(|e| at(&format!("totalMs.{phase}"), e))?,
        };
        t.insert(phase.into(), x);
    }
    let mut out = Map::new();
    out.insert("files".into(), (safe_integer(get(v.as_object().unwrap(), "files"), false)).map_err(|e| at("files", e))?);
    out.insert("totalMs".into(), Value::Object(t));
    Ok(Value::Object(out))
}

/// normalizeManifest: `top` is the manifest (its `items` key, if any, is
/// ignored here), `items` normalizes the clip list at the point Node does.
pub fn normalize_top(top: &Map<String, Value>, items: impl FnOnce() -> R<Vec<std::sync::Arc<super::Item>>>) -> R<(Map<String, Value>, Vec<std::sync::Arc<super::Item>>)> {
    // rejectUnknownFields(value, TOP_FIELDS)
    for k in top.keys() {
        if !TOP_FIELDS.contains(&k.as_str()) {
            let mut e = se(if is_sensitive_field(k) { "SENSITIVE_MANIFEST_DATA" } else { "INVALID_MANIFEST" });
            e.path = Some(field_name(k));
            e.message = "field is not allowed".into();
            return Err(e);
        }
    }
    if top.get("schemaVersion").and_then(safe_int_of) != Some(MANIFEST_VERSION) || !matches!(top.get("schemaVersion"), Some(Value::Number(_))) {
        return Err(se("UNSUPPORTED_MANIFEST_VERSION"));
    }
    let id = match top.get("id") {
        Some(Value::String(s)) => s.clone(),
        _ => return Err(se("INVALID_JOB_ID")),
    };
    assert_safe_job_id(&id)?;
    let (state, state_s) = match top.get("state") {
        Some(Value::String(s)) => match JobState::known(s) {
            Some(known) => (known, s.clone()),
            None => return invalid("state: expected known job state"),
        },
        _ => return invalid("state: expected string"),
    };
    let mut out = Map::new();
    out.insert("schemaVersion".into(), Value::from(MANIFEST_VERSION));
    out.insert("id".into(), Value::String(id));
    out.insert("state".into(), Value::String(state_s));
    out.insert("revision".into(), (safe_integer(get(top, "revision"), false)).map_err(|e| at("revision", e))?);
    out.insert("config".into(), (normalize_config(get(top, "config"))).map_err(|e| at("config", e))?);
    // (items: placed after config when written)
    let items = items()?;
    let mut seen = std::collections::HashSet::with_capacity(items.len());
    if !items.iter().all(|i| seen.insert(i.id())) {
        return invalid("items.id: duplicate item identifier");
    }
    out.insert("counters".into(), Value::Object(normalize_counters(get(top, "counters"), &COUNTER_FIELDS).map_err(|e| at("counters", e))?));
    let summary = match top.get("summary") {
        Some(Value::Null) => Value::Null,
        other => normalize_summary(other.unwrap_or(&Value::Bool(false))).map_err(|e| at("summary", e))?,
    };
    out.insert("summary".into(), summary);
    if let Some(sd) = top.get("summaryDismissed") {
        if !sd.is_boolean() {
            return invalid("summaryDismissed: expected boolean");
        }
        if sd == &Value::Bool(true) {
            out.insert("summaryDismissed".into(), Value::Bool(true));
        }
    }
    if let Some(v)=top.get("permissionBlock").filter(|v|!v.is_null()) {
        let report:crate::converter::folder_access::Report=serde_json::from_value(v.clone()).map_err(|_|refused("permissionBlock","invalid folder report"))?;
        if report.roots.len()>2 || report.roots.iter().any(|r|r.examples.len()>5 || r.unreadable.examples.len()>5) {return Err(refused("permissionBlock","too many examples"));}
        out.insert("permissionBlock".into(),v.clone());
    }
    if let Some(v)=top.get("discoveryIssues").filter(|v|!v.is_null()) {
        let issues:crate::converter::folder_access::Issues=serde_json::from_value(v.clone()).map_err(|_|refused("discoveryIssues","invalid discovery report"))?;
        if issues.examples.len()>5 {return Err(refused("discoveryIssues","too many examples"));}
        out.insert("discoveryIssues".into(),v.clone());
    }
    if let Some(dc) = top.get("discoveryComplete") {
        if !dc.is_boolean() {
            return invalid("discoveryComplete: expected boolean");
        }
        out.insert("discoveryComplete".into(), dc.clone());
    }
    optional(&mut out, top, "createdAt", |x| safe_integer(x, false))?;
    optional(&mut out, top, "updatedAt", |x| safe_integer(x, false))?;
    optional(&mut out, top, "pausedMs", |x| safe_integer(x, false))?;
    if let Some(ma) = top.get("moreAfter") {
        if !ma.is_null() {
            out.insert("moreAfter".into(), (bounded_path(ma, false, true)).map_err(|e| at("moreAfter", e))?);
        }
    }
    optional(&mut out, top, "activeItemId", portable_item_id)?;
    optional(&mut out, top, "ownedPaths", normalize_owned_paths)?;
    let op = out.get("ownedPaths").cloned();
    optional(&mut out, top, "ownedArtifacts", |x| normalize_owned_artifacts(x, op.as_ref()))?;
    optional(&mut out, top, "publicationArtifact", normalize_publication)?;
    optional(&mut out, top, "replacementPhase", |x| match x.as_str().and_then(ReplacementPhase::known) {
        Some(_) => Ok(x.clone()),
        None => invalid("expected known replacement phase"),
    })?;
    optional(&mut out, top, "failure", normalize_failure)?;
    optional(&mut out, top, "timings", normalize_timings)?;
    if let Some(r) = top.get("recovery") {
        if !r.is_null() {
            let rec = normalize_recovery(r, &out).map_err(|e| at("recovery", e))?;
            out.insert("recovery".into(), rec);
        }
    }
    let active = out.get("activeItemId").and_then(Value::as_str).map(str::to_string);
    if let Some(a) = &active {
        if !items.iter().any(|i| i.id() == a) {
            return invalid("activeItemId: must name an item in the job");
        }
    }
    if state.is_transaction() && active.is_none() {
        return invalid("activeItemId: required for a transaction state");
    }
    let resume_state = out.get("recovery").and_then(|r| r.get("resumeState")).and_then(Value::as_str).map(JobState::parse);
    if state == JobState::PausedNetwork && resume_state != Some(JobState::Waiting) && active.is_none() {
        return invalid("activeItemId: required for network pause unless resuming waiting");
    }
    let output_mode = out["config"]["outputMode"].as_str().unwrap_or("").to_string();
    let phase = out.get("replacementPhase").and_then(Value::as_str).map(ReplacementPhase::parse);
    if state == JobState::Replacing && (phase.is_none() || output_mode != "replace") {
        return invalid("replacementPhase/config.outputMode: replacing requires a phase and replace mode");
    }
    if let Some(p) = &phase {
        let rec_phase = out.get("recovery").and_then(|r| r.get("phase")).and_then(Value::as_str).map(ReplacementPhase::parse);
        if state != JobState::Replacing && state != JobState::Paused && !(state == JobState::PausedNetwork && resume_state == Some(JobState::Replacing) && rec_phase.as_ref() == Some(p)) {
            return invalid("replacementPhase: only valid during replacement or matching recovery");
        }
    }
    if state == JobState::Completed {
        if out.contains_key("summaryDismissed") {
            if !out["summary"].is_null() {
                return invalid("summary: dismissed summary must be null");
            }
        } else if out["summary"].is_null() || !same_counters(&out["summary"], &out["counters"]) {
            return invalid("summary: completed job requires summary matching counters");
        }
    } else if !out["summary"].is_null() || out.contains_key("summaryDismissed") {
        return invalid("summary/summaryDismissed: only valid for a completed job");
    }
    if state == JobState::Failed && !out.contains_key("failure") {
        return invalid("failure: required for failed job");
    }
    if state != JobState::Failed && out.contains_key("failure") {
        return invalid("failure: only valid for failed job");
    }
    if state == JobState::Paused && out.get("recovery").and_then(|r| r.get("fromState")).and_then(Value::as_str).map(JobState::parse) == Some(JobState::Replacing) && output_mode != "replace" {
        return invalid("config.outputMode: replacement recovery requires replace mode");
    }
    check_publication(&out)?;
    Ok((out, items))
}
