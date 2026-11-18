//! Who a request comes from, and whether that is the home network
//! (server/clientAddress.js). The socket's own address; X-Forwarded-For only
//! with TRUST_PROXY and only from a trusted proxy, read right to left.

use axum::http::HeaderMap;
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};

const LOCAL_V4: [(&str, u8); 5] = [("127.0.0.0", 8), ("10.0.0.0", 8), ("172.16.0.0", 12), ("192.168.0.0", 16), ("169.254.0.0", 16)];
const LOCAL_V6: [(&str, u8); 3] = [("::1", 128), ("fc00::", 7), ("fe80::", 10)];
const TAILSCALE: [(&str, u8); 2] = [("100.64.0.0", 10), ("fd7a:115c:a1e0::", 48)];

fn is_v4_text(s: &str) -> bool {
    s.parse::<Ipv4Addr>().is_ok()
}

/// One spelling of an address: no brackets or port, no ::ffff: on IPv4, IPv6 lower-case and shortened.
pub fn normalize_ip(value: &str) -> Option<String> {
    let mut s = value.trim().to_string();
    if s.is_empty() || s.encode_utf16().count() > 100 {
        return None;
    }
    // [addr] or [addr]:port
    if let Some(rest) = s.strip_prefix('[') {
        if let Some(end) = rest.find(']') {
            let tail = &rest[end + 1..];
            if !rest[..end].is_empty() && (tail.is_empty() || (tail.starts_with(':') && tail.len() > 1 && tail[1..].bytes().all(|b| b.is_ascii_digit()))) {
                s = rest[..end].to_string();
            }
        }
    } else if let Some((a, p)) = s.rsplit_once(':') {
        // a.b.c.d:port
        let dotted = a.split('.').count() == 4 && a.split('.').all(|o| (1..=3).contains(&o.len()) && o.bytes().all(|b| b.is_ascii_digit()));
        if dotted && !p.is_empty() && p.bytes().all(|b| b.is_ascii_digit()) {
            s = a.to_string();
        }
    }
    // a zone (fe80::1%eth0)
    if let Some(i) = s.rfind('%') {
        let zone = &s[i + 1..];
        if !zone.is_empty() && zone.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'.' | b'-')) {
            s.truncate(i);
        }
    }
    let low = s.to_ascii_lowercase();
    if let Some(v4) = low.strip_prefix("::ffff:") {
        if is_v4_text(v4) {
            s = v4.to_string();
        }
    }
    if is_v4_text(&s) {
        return Some(s);
    }
    let a: Ipv6Addr = s.parse().ok()?;
    if let Some(v4) = a.to_ipv4_mapped() {
        return Some(v4.to_string());
    }
    Some(a.to_string())
}

#[derive(Debug, Clone, PartialEq)]
pub struct Cidr {
    pub address: String,
    pub prefix: u8,
    pub v6: bool,
    pub text: String,
}

/// An address or a range (a.b.c.d/n, x::/n).
pub fn parse_cidr(value: &str) -> Option<Cidr> {
    let text = value.trim();
    // /^(.+?)(?:\/(\d{1,3}))?$/
    let (a, p) = match text.rsplit_once('/') {
        Some((a, p)) if !a.is_empty() && (1..=3).contains(&p.len()) && p.bytes().all(|b| b.is_ascii_digit()) => (a, Some(p)),
        _ => (text, None),
    };
    if a.is_empty() {
        return None;
    }
    let address = normalize_ip(a)?;
    let v6 = !is_v4_text(&address);
    let max = if v6 { 128 } else { 32 };
    let prefix: u32 = match p {
        Some(p) => p.parse().ok()?,
        None => max,
    };
    if prefix > max {
        return None;
    }
    let text = if prefix == max { address.clone() } else { format!("{address}/{prefix}") };
    Some(Cidr { address, prefix: prefix as u8, v6, text })
}

#[derive(Debug, Clone)]
struct Range {
    net: u128,
    prefix: u8,
    v6: bool,
}

fn bits(ip: &IpAddr) -> (u128, bool) {
    match ip {
        IpAddr::V4(a) => (u32::from(*a) as u128, false),
        IpAddr::V6(a) => (u128::from(*a), true),
    }
}

impl Range {
    fn new(address: &str, prefix: u8) -> Option<Range> {
        let ip: IpAddr = address.parse().ok()?;
        let (n, v6) = bits(&ip);
        Some(Range { net: n, prefix, v6 })
    }
    fn contains(&self, ip: &IpAddr) -> bool {
        let (n, v6) = bits(ip);
        if v6 != self.v6 {
            return false;
        }
        let width = if v6 { 128 } else { 32 };
        if self.prefix == 0 {
            return true;
        }
        let shift = width - self.prefix as u32;
        (n >> shift) == (self.net >> shift)
    }
}

/// A set of ranges (net.BlockList).
#[derive(Debug, Clone)]
pub struct Matcher {
    ranges: Vec<Range>,
}

impl Matcher {
    fn of(list: &[(&str, u8)]) -> Matcher {
        Matcher { ranges: list.iter().filter_map(|(a, p)| Range::new(a, *p)).collect() }
    }
    pub fn check(&self, ip: &str) -> bool {
        let Some(a) = normalize_ip(ip) else { return false };
        let Ok(ip) = a.parse::<IpAddr>() else { return false };
        self.ranges.iter().any(|r| r.contains(&ip))
    }
}

/// Loopback, private, link-local or unique local: the local network.
pub fn is_local_network(ip: &str) -> bool {
    let mut all: Vec<(&str, u8)> = LOCAL_V4.to_vec();
    all.extend(LOCAL_V6);
    Matcher::of(&all).check(ip)
}

/// Which connections may tell us the client's address: TRUSTED_PROXIES, else the local network.
pub fn proxy_matcher(list: Option<&str>) -> Result<Matcher, String> {
    let entries: Vec<&str> = list.unwrap_or("").split(|c: char| c.is_whitespace() || c == ',').filter(|s| !s.is_empty()).collect();
    if entries.is_empty() {
        let mut all: Vec<(&str, u8)> = LOCAL_V4.to_vec();
        all.extend(LOCAL_V6);
        return Ok(Matcher::of(&all));
    }
    let mut ranges = Vec::new();
    for e in entries {
        let c = parse_cidr(e).ok_or_else(|| format!("TRUSTED_PROXIES: \"{e}\" is not an address or a range."))?;
        ranges.extend(Range::new(&c.address, c.prefix));
    }
    Ok(Matcher { ranges })
}

/// The home-network test for these settings ({ tailscale, extra }).
pub fn home_matcher(tailscale: bool, extra: &[String]) -> Matcher {
    let mut all: Vec<(&str, u8)> = LOCAL_V4.to_vec();
    all.extend(LOCAL_V6);
    if tailscale {
        all.extend(TAILSCALE);
    }
    let mut m = Matcher::of(&all);
    for e in extra {
        if let Some(c) = parse_cidr(e) {
            m.ranges.extend(Range::new(&c.address, c.prefix));
        }
    }
    m
}

/// The X-Forwarded-For hops, left (the first client) to right (the last proxy); at most 50.
pub fn forwarded_hops(headers: &HeaderMap) -> Vec<String> {
    let text: Vec<String> = headers.get_all("x-forwarded-for").iter().map(|v| String::from_utf8_lossy(v.as_bytes()).into_owned()).collect();
    let joined = text.join(",");
    let hops: Vec<String> = joined.split(',').map(|h| h.trim().to_string()).filter(|h| !h.is_empty()).collect();
    let n = hops.len();
    hops.into_iter().skip(n.saturating_sub(50)).collect()
}

/// Proxy settings: TRUST_PROXY and who the trusted proxies are.
#[derive(Debug, Clone)]
pub struct Proxy {
    pub trust_proxy: bool,
    pub trusted: Matcher,
}

/// The client's address for every decision (clientAddress.js clientAddress).
pub fn client_address(socket: Option<&str>, headers: &HeaderMap, proxy: &Proxy) -> String {
    let Some(sock) = socket.and_then(normalize_ip) else { return "?".into() };
    if !proxy.trust_proxy || !proxy.trusted.check(&sock) {
        return sock;
    }
    let hops = forwarded_hops(headers);
    for i in (0..hops.len()).rev() {
        let Some(ip) = normalize_ip(&hops[i]) else {
            let cleaned: String = hops[i].chars().filter(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | ':' | '-')).take(40).collect();
            return format!("unknown({cleaned})");
        };
        if !proxy.trusted.check(&ip) {
            return ip;
        }
        if i == 0 {
            return ip;
        }
    }
    sock
}

/// Whether a header the proxy sets (X-Forwarded-Proto, -Host) may be believed.
pub fn from_trusted_proxy(socket: Option<&str>, proxy: &Proxy) -> bool {
    proxy.trust_proxy && socket.and_then(normalize_ip).is_some_and(|s| proxy.trusted.check(&s))
}

fn expand_v6(a: &str) -> Vec<String> {
    let (head, tail) = match a.split_once("::") {
        Some((h, t)) => (h, Some(t)),
        None => (a, None),
    };
    let h: Vec<&str> = if head.is_empty() { vec![] } else { head.split(':').collect() };
    let t: Vec<&str> = match tail {
        Some(t) if !t.is_empty() => t.split(':').collect(),
        _ => vec![],
    };
    let fill = if tail.is_none() { 0 } else { 8usize.saturating_sub(h.len() + t.len()) };
    h.iter().copied().chain(std::iter::repeat_n("0", fill)).chain(t.iter().copied()).map(|g| if g.is_empty() { "0".into() } else { g.to_string() }).collect()
}

/// The key bans count by: the address, or for IPv6 its /64.
pub fn ban_key(ip: &str) -> String {
    let Some(a) = normalize_ip(ip) else {
        let s = if ip.is_empty() { "?" } else { ip };
        return s.chars().take(64).collect();
    };
    if is_v4_text(&a) {
        return a;
    }
    let full = expand_v6(&a);
    let head = full.iter().take(4).cloned().collect::<Vec<_>>().join(":");
    format!("{}/64", normalize_ip(&format!("{head}::")).unwrap_or(head))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn h(xff: &str) -> HeaderMap {
        let mut m = HeaderMap::new();
        m.insert("x-forwarded-for", xff.parse().unwrap());
        m
    }

    #[test]
    fn normalizes() {
        assert_eq!(normalize_ip("::ffff:192.168.1.5").as_deref(), Some("192.168.1.5"));
        assert_eq!(normalize_ip("[2001:DB8::1]:443").as_deref(), Some("2001:db8::1"));
        assert_eq!(normalize_ip("10.0.0.1:8080").as_deref(), Some("10.0.0.1"));
        assert_eq!(normalize_ip("fe80::1%eth0").as_deref(), Some("fe80::1"));
        assert_eq!(normalize_ip("::ffff:7f00:1").as_deref(), Some("127.0.0.1"));
        assert_eq!(normalize_ip("2001:0db8:0000:0000:0000:0000:0000:0001").as_deref(), Some("2001:db8::1"));
        assert_eq!(normalize_ip("nope"), None);
        assert_eq!(normalize_ip("01.2.3.4"), None);
        assert_eq!(normalize_ip(""), None);
    }

    #[test]
    fn cidrs() {
        assert_eq!(parse_cidr("192.0.2.0/24").unwrap().text, "192.0.2.0/24");
        assert_eq!(parse_cidr("192.0.2.1/32").unwrap().text, "192.0.2.1");
        assert_eq!(parse_cidr("2001:DB8::/32").unwrap().text, "2001:db8::/32");
        assert!(parse_cidr("10.0.0.0/33").is_none());
        assert!(parse_cidr("x/8").is_none());
    }

    #[test]
    fn home_and_local() {
        assert!(is_local_network("192.168.1.5"));
        assert!(is_local_network("::ffff:10.1.2.3"));
        assert!(is_local_network("fd12::1"));
        assert!(!is_local_network("8.8.8.8"));
        assert!(!home_matcher(false, &[]).check("100.100.1.1"));
        assert!(home_matcher(true, &[]).check("100.100.1.1"));
        assert!(home_matcher(false, &["203.0.113.0/24".into()]).check("203.0.113.9"));
    }

    #[test]
    fn forwarded_only_from_a_trusted_proxy() {
        let on = Proxy { trust_proxy: true, trusted: proxy_matcher(None).unwrap() };
        let off = Proxy { trust_proxy: false, trusted: proxy_matcher(None).unwrap() };
        assert_eq!(client_address(Some("::ffff:10.0.0.2"), &h("192.168.1.5, 8.8.8.8"), &off), "10.0.0.2");
        assert_eq!(client_address(Some("10.0.0.2"), &h("192.168.1.5, 8.8.8.8"), &on), "8.8.8.8");
        // the client wrote a home address to the left: ignored
        assert_eq!(client_address(Some("10.0.0.2"), &h("192.168.1.5, 10.0.0.3"), &on), "192.168.1.5");
        assert_eq!(client_address(Some("8.8.4.4"), &h("192.168.1.5"), &on), "8.8.4.4");
        assert_eq!(client_address(Some("10.0.0.2"), &h("bad<x>, 10.0.0.3"), &on), "unknown(badx)");
        assert_eq!(client_address(None, &HeaderMap::new(), &on), "?");
        assert!(proxy_matcher(Some("nope")).is_err());
    }

    /// test/clientAddress.test.js, case for case
    #[test]
    fn node_client_address_tests() {
        assert_eq!(normalize_ip("::FFFF:7f00:1").as_deref(), Some("127.0.0.1"));
        assert_eq!(normalize_ip("[2001:DB8:0:0::1]:443").as_deref(), Some("2001:db8::1"));
        assert_eq!(normalize_ip("198.51.100.7:51234").as_deref(), Some("198.51.100.7"));
        for junk in ["", "unknown", "1.2.3", "<script>", &"a".repeat(200)] {
            assert_eq!(normalize_ip(junk), None, "{junk}");
        }
        assert_eq!(parse_cidr("10.1.0.0/16"), Some(Cidr { address: "10.1.0.0".into(), prefix: 16, v6: false, text: "10.1.0.0/16".into() }));
        assert_eq!(parse_cidr("2001:db8::/48").unwrap().text, "2001:db8::/48");
        for ip in ["127.0.0.1", "10.2.3.4", "172.16.0.1", "172.31.255.254", "192.168.1.5", "169.254.1.1", "::1", "fd00::5", "fe80::1", "::ffff:10.0.0.1"] {
            assert!(is_local_network(ip), "{ip}");
        }
        for ip in ["100.64.0.1", "100.100.100.100", "172.32.0.1", "8.8.8.8", "203.0.113.9", "2001:db8::1", "2600::1", "junk"] {
            assert!(!is_local_network(ip), "{ip}");
        }
        let plain = Proxy { trust_proxy: false, trusted: proxy_matcher(None).unwrap() };
        let proxied = Proxy { trust_proxy: true, trusted: proxy_matcher(None).unwrap() };
        let ca = |from: &str, xff: Option<&str>, p: &Proxy| client_address(Some(from), &xff.map(h).unwrap_or_default(), p);
        assert_eq!(ca("203.0.113.9", Some("192.168.1.5"), &plain), "203.0.113.9");
        assert_eq!(ca("::ffff:198.51.100.7", Some("127.0.0.1"), &plain), "198.51.100.7");
        assert_eq!(ca("127.0.0.1", Some("203.0.113.9"), &plain), "127.0.0.1");
        assert_eq!(ca("203.0.113.9", Some("192.168.1.5"), &proxied), "203.0.113.9");
        assert_eq!(ca("2001:db8::66", Some("127.0.0.1, 10.0.0.1"), &proxied), "2001:db8::66");
        assert!(!from_trusted_proxy(Some("203.0.113.9"), &proxied));
        assert_eq!(ca("100.70.1.2", Some("192.168.1.5"), &proxied), "100.70.1.2");
        assert_eq!(ca("172.17.0.1", Some("203.0.113.9"), &proxied), "203.0.113.9");
        assert_eq!(ca("::ffff:172.17.0.1", Some("::ffff:198.51.100.7"), &proxied), "198.51.100.7");
        assert_eq!(ca("172.17.0.1", Some("192.168.1.5, 203.0.113.9"), &proxied), "203.0.113.9");
        assert_eq!(ca("127.0.0.1", Some("1.1.1.1, 203.0.113.9, 10.0.0.2"), &proxied), "203.0.113.9");
        assert_eq!(ca("172.17.0.1", Some("192.168.1.20"), &proxied), "192.168.1.20");
        assert_eq!(ca("172.17.0.1", Some("10.0.0.5, 192.168.1.20"), &proxied), "10.0.0.5");
        let mut two = HeaderMap::new();
        two.append("x-forwarded-for", "192.168.1.5".parse().unwrap());
        two.append("x-forwarded-for", "203.0.113.9".parse().unwrap());
        assert_eq!(client_address(Some("172.17.0.1"), &two, &proxied), "203.0.113.9");
        assert_eq!(ca("172.17.0.1", None, &proxied), "172.17.0.1");
        let odd = ca("172.17.0.1", Some("192.168.1.5, <evil>"), &proxied);
        assert!(odd.starts_with("unknown("));
        assert!(!home_matcher(false, &[]).check(&odd));
        assert!(from_trusted_proxy(Some("172.17.0.1"), &proxied));
        assert!(!from_trusted_proxy(Some("172.17.0.1"), &plain));
        let o = Proxy { trust_proxy: true, trusted: proxy_matcher(Some("10.0.0.2, 100.64.0.0/10")).unwrap() };
        assert_eq!(ca("10.0.0.2", Some("203.0.113.9"), &o), "203.0.113.9");
        assert_eq!(ca("100.101.1.1", Some("203.0.113.9"), &o), "203.0.113.9");
        assert_eq!(ca("127.0.0.1", Some("192.168.1.5"), &o), "127.0.0.1");
        assert_eq!(ca("10.0.0.3", Some("8.8.8.8"), &o), "10.0.0.3");
        assert!(proxy_matcher(Some("nonsense")).unwrap_err().contains("TRUSTED_PROXIES"));
        let home = home_matcher(false, &[]);
        assert!(home.check("192.168.1.5") && home.check("::ffff:10.1.1.1") && !home.check("100.101.1.1") && !home.check("203.0.113.9"));
        let ts = home_matcher(true, &[]);
        assert!(ts.check("100.101.1.1") && ts.check("fd7a:115c:a1e0::1234"));
        let extra = home_matcher(false, &["198.51.100.0/24".into(), "2001:db8:aa::/48".into(), "203.0.113.77".into()]);
        assert!(extra.check("198.51.100.200") && extra.check("2001:db8:aa:1::5") && extra.check("203.0.113.77") && !extra.check("203.0.113.78"));
        assert_eq!(ban_key("2001:db8:1:2:aaaa::1"), "2001:db8:1:2::/64");
        assert_eq!(ban_key("2001:db8:1:2:bbbb::9"), "2001:db8:1:2::/64");
    }

    #[test]
    fn ban_keys() {
        assert_eq!(ban_key("::ffff:1.2.3.4"), "1.2.3.4");
        assert_eq!(ban_key("2001:db8:1:2:3:4:5:6"), "2001:db8:1:2::/64");
        assert_eq!(ban_key("2001:db8::5"), "2001:db8::/64");
        assert_eq!(ban_key("garbage"), "garbage");
    }
}
