//! What server/index.js does to pages and scripts before they are sent:
//! versioned links (/v/<version>/…), the versioned imports of a versioned
//! script, the critical-update bar, the Studio and Encoder shims, and the
//! early-data hint (web/prefetch.js).

use regex::Regex;
use std::sync::OnceLock;

pub const CRITICAL_TAG: &str = "<script src=\"/web/critical.js\" defer></script>";
pub const LONG_CACHE: &str = "private, max-age=31536000, immutable";

fn re(cell: &'static OnceLock<Regex>, pat: &str) -> &'static Regex {
    cell.get_or_init(|| Regex::new(pat).unwrap())
}

/// The first `<head…>` (also `<header…>`, as /<head([^>]*)>/i matches it).
fn head_open() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    re(&R, r"(?i)<head[^>]*>")
}

/// withCriticalBar: the bar's script in every page, once.
pub fn with_critical_bar(html: &str) -> String {
    if html.contains(CRITICAL_TAG) {
        return html.to_string();
    }
    static HEAD: OnceLock<Regex> = OnceLock::new();
    static BODY: OnceLock<Regex> = OnceLock::new();
    for r in [re(&HEAD, r"(?i)</head>"), re(&BODY, r"(?i)</body>")] {
        if let Some(m) = r.find(html) {
            return format!("{}{CRITICAL_TAG}\n{}", &html[..m.start()], &html[m.start()..]);
        }
    }
    format!("{html}\n{CRITICAL_TAG}\n")
}

fn after_head(html: &str, inject: &str) -> String {
    match head_open().find(html) {
        Some(m) => format!("{}\n{inject}{}", &html[..m.end()], &html[m.end()..]),
        None => html.to_string(),
    }
}

/// studioHtml: the web shim and the one units choice before any Studio script.
pub fn studio_html(html: &str) -> String {
    after_head(
        html,
        "<meta name=\"color-scheme\" content=\"dark\">\n<script src=\"/web/webFlag.js\"></script>\n<script src=\"/web/electronApiShim.js\"></script>\n<script src=\"/web/units.js\"></script>\n<script src=\"/web/studioTouch.js\"></script>\n<link rel=\"stylesheet\" href=\"/web/studioEmbed.css\">",
    )
}

/// encoderHtml: the same, deferred, and the skeleton's stylesheet inline.
pub fn encoder_html(html: &str, skeleton: Option<&str>) -> String {
    let out = after_head(
        html,
        "<meta name=\"color-scheme\" content=\"dark\">\n<script src=\"/web/webFlag.js\" defer></script>\n<script src=\"/web/electronApiShim.js\" defer></script>\n<script src=\"/web/units.js\" defer></script>\n<link rel=\"preload\" href=\"/web/studioEmbed.css\" as=\"style\">",
    );
    let link = "<link rel=\"stylesheet\" href=\"/web/encoderSkeleton.css\">";
    match (skeleton, out.find(link)) {
        (Some(css), Some(at)) if !css.contains("</") => format!("{}<style>\n{css}</style>{}", &out[..at], &out[at + link.len()..]),
        _ => out,
    }
}

/// escHtml
pub fn esc_html(s: &str) -> String {
    let mut o = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            '&' => o.push_str("&amp;"),
            '<' => o.push_str("&lt;"),
            '>' => o.push_str("&gt;"),
            '"' => o.push_str("&quot;"),
            '\'' => o.push_str("&#39;"),
            c => o.push(c),
        }
    }
    o
}

/// withPrefetch: web/prefetch.js first in the head, with what this interface asked for before.
pub fn with_prefetch(html: &str, hints: &[String]) -> String {
    if hints.is_empty() {
        return html.to_string();
    }
    let tag = format!("<script src=\"/web/prefetch.js\" data-urls=\"{}\"></script>", esc_html(&serde_json::to_string(hints).unwrap()));
    match head_open().find(html) {
        Some(m) => format!("{}\n{tag}{}", &html[..m.end()], &html[m.end()..]),
        None => format!("{tag}\n{html}"),
    }
}

/// path.posix.normalize
pub fn posix_normalize(p: &str) -> String {
    if p.is_empty() {
        return ".".into();
    }
    let abs = p.starts_with('/');
    let trailing = p.ends_with('/');
    let mut out: Vec<&str> = Vec::new();
    for seg in p.split('/') {
        match seg {
            "" | "." => {}
            ".." => {
                if out.last().is_some_and(|l| *l != "..") {
                    out.pop();
                } else if !abs {
                    out.push("..");
                }
            }
            s => out.push(s),
        }
    }
    let mut s = out.join("/");
    if s.is_empty() && !abs {
        s = ".".into();
    }
    if !s.is_empty() && trailing {
        s.push('/');
    }
    if abs { format!("/{s}") } else { s }
}

/// path.posix.join(a, b)
pub fn posix_join(a: &str, b: &str) -> String {
    let joined = match (a.is_empty(), b.is_empty()) {
        (true, true) => return ".".into(),
        (true, false) => b.to_string(),
        (false, true) => a.to_string(),
        _ => format!("{a}/{b}"),
    };
    posix_normalize(&joined)
}

/// path.posix.dirname
pub fn posix_dirname(p: &str) -> String {
    let t = p.trim_end_matches('/');
    if t.is_empty() {
        return if p.starts_with('/') { "/".into() } else { ".".into() };
    }
    match t.rfind('/') {
        Some(i) => {
            let d = t[..i].trim_end_matches('/');
            if d.is_empty() { "/".into() } else { d.to_string() }
        }
        None => ".".into(),
    }
}

fn word(c: u8) -> bool {
    c.is_ascii_alphanumeric() || c == b'_'
}

/// The first src= or href= attribute of a tag: (start, end, attr, quote, url),
/// as /\b(src|href)=(["'])([^"']+)\2/i finds it.
fn first_link_attr(tag: &str) -> Option<(usize, usize, &str, char, &str)> {
    let b = tag.as_bytes();
    let lower = tag.to_ascii_lowercase();
    let lb = lower.as_bytes();
    let mut i = 0;
    while i < b.len() {
        for name in ["src", "href"] {
            let n = name.len();
            if lb[i..].starts_with(name.as_bytes()) && (i == 0 || !word(b[i - 1])) && b.get(i + n) == Some(&b'=') {
                if let Some(&q) = b.get(i + n + 1) {
                    if q == b'"' || q == b'\'' {
                        let s = i + n + 2;
                        let mut e = s;
                        while e < b.len() && b[e] != b'"' && b[e] != b'\'' {
                            e += 1;
                        }
                        if e > s && b.get(e) == Some(&q) {
                            return Some((i, e + 1, &tag[i..i + n], q as char, &tag[s..e]));
                        }
                    }
                }
            }
        }
        i += 1;
    }
    None
}

/// versionLinks: a page's own scripts and stylesheets as /v/<version>/<path>.
pub fn version_links(html: &str, page_dir: &str, version: &str) -> String {
    static TAG: OnceLock<Regex> = OnceLock::new();
    static OTHER: OnceLock<Regex> = OnceLock::new();
    static ASSET: OnceLock<Regex> = OnceLock::new();
    let tag_re = re(&TAG, r"(?i)<(?:script|link)(?-u:\b)[^>]*>");
    let other = re(&OTHER, r"(?i)^[a-z][a-z0-9+.\-]*:|^//|^#");
    let asset = re(&ASSET, r"(?i)\.(m?js|css)$");
    tag_re
        .replace_all(html, |caps: &regex::Captures| {
            let tag = &caps[0];
            let Some((s, e, attr, q, url)) = first_link_attr(tag) else { return tag.to_string() };
            if other.is_match(url) {
                return tag.to_string();
            }
            // url.split(/(?=[?#])/, 2): the file, and the part up to the next ? or #
            let (file, rest) = match url.find(['?', '#']) {
                Some(at) => {
                    let after = &url[at + 1..];
                    let end = after.find(['?', '#']).map_or(url.len(), |x| at + 1 + x);
                    (&url[..at], &url[at..end])
                }
                None => (url, ""),
            };
            if !asset.is_match(file) {
                return tag.to_string();
            }
            let abs = if file.starts_with('/') { posix_normalize(file) } else { posix_join(page_dir, file) };
            if !abs.starts_with('/') || abs.starts_with("/api/") || abs.starts_with("/v/") {
                return tag.to_string();
            }
            format!("{}{attr}={q}/v/{version}{abs}{rest}{q}{}", &tag[..s], &tag[e..])
        })
        .into_owned()
}

/// versionScriptLinks: a versioned script's quoted links to /web/ and /shared/ scripts get its version too.
pub fn version_script_links(js: &str, version: &str) -> String {
    let b = js.as_bytes();
    let mut out = String::with_capacity(js.len() + 64);
    let mut last = 0;
    let mut i = 0;
    let class = |c: u8| c.is_ascii_alphanumeric() || matches!(c, b'_' | b'.' | b'/' | b'-');
    while i < b.len() {
        let q = b[i];
        if q == b'\'' || q == b'"' || q == b'`' {
            for dir in ["/web/", "/shared/"] {
                if !js[i + 1..].starts_with(dir) {
                    continue;
                }
                let s = i + 1 + dir.len();
                let mut e = s;
                while e < b.len() && class(b[e]) {
                    e += 1;
                }
                let rest = &js[s..e];
                let ok_end = (rest.ends_with(".js") && rest.len() > 3) || (rest.ends_with(".mjs") && rest.len() > 4);
                if e > s && b.get(e) == Some(&q) && ok_end {
                    let q = q as char;
                    out.push_str(&js[last..i]);
                    if rest.contains("..") {
                        out.push_str(&js[i..=e]);
                    } else {
                        out.push_str(&format!("{q}/v/{version}{dir}{rest}{q}"));
                    }
                    last = e + 1;
                    i = e;
                    break;
                }
            }
        }
        i += 1;
    }
    out.push_str(&js[last..]);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn links_get_the_version() {
        let html = r#"<head><link rel="stylesheet" href="shell.css"><script src="/web/app.js?x=1#y" defer></script><script src="https://x/y.js"></script><script src="data:a.js"></script><img src="a.js"><script src="../studio/x.mjs"></script><SCRIPT SRC='/api/x.js'></SCRIPT></head>"#;
        let out = version_links(html, "/web/", "V1");
        assert!(out.contains(r#"href="/v/V1/web/shell.css""#), "{out}");
        assert!(out.contains(r#"src="/v/V1/web/app.js?x=1" defer"#), "{out}");
        assert!(out.contains(r#"src="https://x/y.js""#));
        assert!(out.contains(r#"<img src="a.js">"#));
        assert!(out.contains(r#"src="/v/V1/studio/x.mjs""#));
        assert!(out.contains(r#"SRC='/api/x.js'"#));
    }

    #[test]
    fn script_links_get_the_version() {
        let js = "import('/web/scrub.js'); import '/shared/mapProviders.js'; x = \"/web/a/../b.js\"; y = '/web/x.css'; z = `/web/q.mjs`; w = '/web/.js'; v = '/web/a.js\"";
        let out = version_script_links(js, "V");
        assert_eq!(out, "import('/v/V/web/scrub.js'); import '/v/V/shared/mapProviders.js'; x = \"/web/a/../b.js\"; y = '/web/x.css'; z = `/v/V/web/q.mjs`; w = '/web/.js'; v = '/web/a.js\"");
    }

    #[test]
    fn the_bar_once() {
        assert_eq!(with_critical_bar("<html><HEAD></HEAD></html>"), format!("<html><HEAD>{CRITICAL_TAG}\n</HEAD></html>"));
        assert_eq!(with_critical_bar("<body></body>"), format!("<body>{CRITICAL_TAG}\n</body>"));
        assert_eq!(with_critical_bar("x"), format!("x\n{CRITICAL_TAG}\n"));
        let once = with_critical_bar("<head></head>");
        assert_eq!(with_critical_bar(&once), once);
    }

    #[test]
    fn paths() {
        assert_eq!(posix_normalize("/web/../x//y/./z/"), "/x/y/z/");
        assert_eq!(posix_normalize("/../a"), "/a");
        assert_eq!(posix_join("/studio/", "../assets/x.css"), "/assets/x.css");
        assert_eq!(posix_dirname("/studio/index.html"), "/studio");
        assert_eq!(posix_dirname("/index.html"), "/");
        assert_eq!(posix_dirname("/"), "/");
    }

    #[test]
    fn prefetch_first_in_head() {
        let out = with_prefetch("<!doctype html><head><title>x</title>", &["/api/vehicles".into()]);
        assert_eq!(out, "<!doctype html><head>\n<script src=\"/web/prefetch.js\" data-urls=\"[&quot;/api/vehicles&quot;]\"></script><title>x</title>");
    }

    /// A collapsed clip list is only its arrow: what electronApiShim.js adds to Studio's clip
    /// list (the moments, the vehicle picker) folds away with Studio's own parts, collapsed
    /// (floating layout) and hidden (Classic layout), in web/studioEmbed.css and in the Sentry Six
    /// pack's copy the default interface serves (and its .zip). The camera labels are drawn at
    /// their exact places ("Front" read "Fro nt" with its letters snapped to whole pixels).
    #[test]
    fn a_collapsed_clip_list_shows_only_its_arrow() {
        let repo = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..");
        let read = |p: &str| std::fs::read_to_string(repo.join(p)).unwrap();
        let shim = read("web/electronApiShim.js");
        let at = shim.find("getElementById('clipBrowser')").expect("the shim adds to the clip list");
        assert!(shim[at..].contains("box.className = 'sm-moments'"), "the moments go in the clip list");
        assert!(shim.contains("select.className = 'sm-vehicle-select'"));
        let studio = read("src/renderer/style.css");
        let web = read("web/studioEmbed.css");
        let pack = read("examples/ui-packs/sentry-six/web/studioEmbed.css");
        assert!(pack.starts_with(&web), "the pack's copy starts with web/studioEmbed.css");
        for mode in ["collapsed", "hidden"] {
            let boxed = regex::Regex::new(&format!(r"\.clips-mode-{mode} \.clip-browser \{{[^}}]*width: 44px")).unwrap();
            assert!(boxed.is_match(&studio), "{mode}: Studio's 44 px box");
            for added in ["sm-moments", "sm-vehicle-select"] {
                let gone = regex::Regex::new(&format!(r"\.clips-mode-{mode} #clipBrowser \.{added}\b[^{{]*\{{[^}}]*display:\s*none")).unwrap();
                assert!(gone.is_match(&web), "{mode}: {added}");
            }
        }
        let zip = std::fs::read(repo.join("examples/ui-packs/sentry-six.zip")).unwrap();
        let entries = super::super::zip::read_zip(&zip, &Default::default()).unwrap();
        let css = entries.iter().find(|e| e.name == "web/studioEmbed.css").expect("in the pack's .zip");
        assert_eq!(css.data, pack.as_bytes(), "the .zip holds the folder's copy");
        let label = regex::Regex::new(r"\.multi-label \{[^}]*text-rendering: geometricPrecision").unwrap();
        assert!(label.is_match(&studio), "camera labels at their exact places");
    }
}
