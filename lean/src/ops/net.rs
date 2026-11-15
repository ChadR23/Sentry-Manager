//! Outbound HTTPS, the two places the server asks anything outside: the
//! image registry (updates) and the developers' report receiver (opt-in
//! reports). Behind a trait so tests never reach the network.

use std::io::Read;
use std::time::Duration;

#[derive(Clone, Debug)]
pub struct HttpReq {
    pub method: String,
    pub url: String,
    pub headers: Vec<(String, String)>,
    pub body: Option<Vec<u8>>,
    pub timeout_ms: u64,
    pub follow_redirects: bool,
    /// answers longer than this are refused (the error says so)
    pub max_body: usize,
    pub too_much: String,
}

#[derive(Clone, Debug, Default)]
pub struct HttpRes {
    pub status: u16,
    /// names in lower case
    pub headers: Vec<(String, String)>,
    pub body: Vec<u8>,
}

impl HttpRes {
    pub fn header(&self, name: &str) -> Option<&str> {
        self.headers.iter().find(|(k, _)| k.eq_ignore_ascii_case(name)).map(|(_, v)| v.as_str())
    }
    pub fn text(&self) -> String {
        String::from_utf8_lossy(&self.body).into_owned()
    }
}

pub trait Transport: Send + Sync {
    fn request(&self, r: &HttpReq) -> Result<HttpRes, String>;
}

/// The real one: HTTPS with the system's certificate checks (webpki roots),
/// through the environment's proxy when one is set.
pub struct Https;

impl Transport for Https {
    fn request(&self, r: &HttpReq) -> Result<HttpRes, String> {
        let mut b = ureq::AgentBuilder::new().timeout(Duration::from_millis(r.timeout_ms)).redirects(if r.follow_redirects { 5 } else { 0 });
        if let Some(p) = ["HTTPS_PROXY", "https_proxy"].iter().find_map(|k| std::env::var(k).ok()).filter(|p| !p.is_empty()) {
            if let Ok(proxy) = ureq::Proxy::new(&p) {
                b = b.proxy(proxy);
            }
        }
        let agent = b.build();
        let mut req = agent.request(&r.method, &r.url);
        for (k, v) in &r.headers {
            req = req.set(k, v);
        }
        let res = match &r.body {
            Some(body) => req.send_bytes(body),
            None => req.call(),
        };
        let res = match res {
            Ok(res) => res,
            Err(ureq::Error::Status(_, res)) => res,
            Err(ureq::Error::Transport(t)) => {
                return Err(match t.kind() {
                    ureq::ErrorKind::Io if t.to_string().contains("timed out") => "The receiver did not answer in time.".into(),
                    _ => t.to_string(),
                })
            }
        };
        let status = res.status();
        let headers = res.headers_names().into_iter().filter_map(|n| res.header(&n).map(|v| (n.to_ascii_lowercase(), v.to_string()))).collect();
        let mut body = Vec::new();
        res.into_reader().take(r.max_body as u64 + 1).read_to_end(&mut body).map_err(|e| e.to_string())?;
        if body.len() > r.max_body {
            return Err(r.too_much.clone());
        }
        Ok(HttpRes { status, headers, body })
    }
}

/// application/x-www-form-urlencoded, as URLSearchParams writes a value.
pub fn form_encode(s: &str) -> String {
    let mut out = String::new();
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'*' | b'-' | b'.' | b'_' => out.push(b as char),
            b' ' => out.push('+'),
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}
