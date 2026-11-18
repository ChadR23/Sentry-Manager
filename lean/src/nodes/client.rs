//! nodes.js connectPinned and request: a TLS connection used only when the
//! node presents its pinned certificate, then one HTTP/1.1 request over it
//! (never a new connection) that always settles: an idle timeout, an
//! overall deadline, a cancel, and at most 64 KiB of an answer read into
//! memory.

use super::cancel::Cancel;
use super::pin::{pin_matches, Pin};
use super::{cert_fingerprint, NodeError};
use rustls::client::danger::{HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier};
use rustls::pki_types::{CertificateDer, ServerName, UnixTime};
use rustls::{ClientConfig, ClientConnection, DigitallySignedStruct, SignatureScheme, StreamOwned};
use serde_json::Value;
use std::io::{self, BufRead, BufReader, Read, Write};
use std::net::{IpAddr, Shutdown, SocketAddr, TcpStream, ToSocketAddrs};
use std::sync::{mpsc, Arc, Mutex, OnceLock};
use std::time::Duration;

pub const REQUEST_TIMEOUT_MS: u64 = 30_000;
const MAX_ANSWER: usize = 64 * 1024;
/// Node's maxHeaderSize
const MAX_HEADER: usize = 16 * 1024;

/// Accepts whatever is presented (the pin is checked after the handshake,
/// as Node's rejectUnauthorized: false + getPeerCertificate), but still
/// checks the handshake's signatures: the node must hold the key.
#[derive(Debug)]
struct AcceptAny(Arc<rustls::crypto::CryptoProvider>);

impl ServerCertVerifier for AcceptAny {
    fn verify_server_cert(&self, _: &CertificateDer<'_>, _: &[CertificateDer<'_>], _: &ServerName<'_>, _: &[u8], _: UnixTime) -> Result<ServerCertVerified, rustls::Error> {
        Ok(ServerCertVerified::assertion())
    }
    fn verify_tls12_signature(&self, message: &[u8], cert: &CertificateDer<'_>, dss: &DigitallySignedStruct) -> Result<HandshakeSignatureValid, rustls::Error> {
        rustls::crypto::verify_tls12_signature(message, cert, dss, &self.0.signature_verification_algorithms)
    }
    fn verify_tls13_signature(&self, message: &[u8], cert: &CertificateDer<'_>, dss: &DigitallySignedStruct) -> Result<HandshakeSignatureValid, rustls::Error> {
        rustls::crypto::verify_tls13_signature(message, cert, dss, &self.0.signature_verification_algorithms)
    }
    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        self.0.signature_verification_algorithms.supported_schemes()
    }
}

fn config() -> Arc<ClientConfig> {
    static C: OnceLock<Arc<ClientConfig>> = OnceLock::new();
    C.get_or_init(|| {
        let provider = Arc::new(rustls::crypto::ring::default_provider());
        let mut c = ClientConfig::builder_with_provider(provider.clone())
            .with_protocol_versions(&[&rustls::version::TLS13, &rustls::version::TLS12])
            .expect("TLS 1.2 and 1.3")
            .dangerous()
            .with_custom_certificate_verifier(Arc::new(AcceptAny(provider)))
            .with_no_client_auth();
        c.alpn_protocols = vec![b"http/1.1".to_vec()];
        Arc::new(c)
    })
    .clone()
}

/// The name Node gives an io error (err.code).
pub fn errno_name(e: &io::Error) -> String {
    let named = match e.raw_os_error() {
        Some(libc::ECONNREFUSED) => "ECONNREFUSED",
        Some(libc::ECONNRESET) => "ECONNRESET",
        Some(libc::EPIPE) => "EPIPE",
        Some(libc::ETIMEDOUT) => "ETIMEDOUT",
        Some(libc::EHOSTUNREACH) => "EHOSTUNREACH",
        Some(libc::ENETUNREACH) => "ENETUNREACH",
        Some(libc::EADDRNOTAVAIL) => "EADDRNOTAVAIL",
        Some(libc::ECONNABORTED) => "ECONNABORTED",
        Some(libc::EACCES) => "EACCES",
        Some(libc::ENOENT) => "ENOENT",
        Some(libc::EEXIST) => "EEXIST",
        Some(libc::ENOSPC) => "ENOSPC",
        _ => match e.kind() {
            io::ErrorKind::ConnectionRefused => "ECONNREFUSED",
            io::ErrorKind::ConnectionReset => "ECONNRESET",
            io::ErrorKind::BrokenPipe => "EPIPE",
            io::ErrorKind::UnexpectedEof => "ECONNRESET",
            io::ErrorKind::InvalidData => "EPROTO",
            _ => "",
        },
    };
    if named.is_empty() {
        e.to_string()
    } else {
        named.to_string()
    }
}

fn timeout() -> NodeError {
    NodeError::new("The node did not answer.", 504, "NODE_TIMEOUT")
}

fn is_timeout(e: &io::Error) -> bool {
    matches!(e.kind(), io::ErrorKind::WouldBlock | io::ErrorKind::TimedOut)
}

pub type Tls = StreamOwned<ClientConnection, TcpStream>;

pub struct Connection {
    pub stream: Tls,
    pub tcp: TcpStream,
    pub fingerprint: String,
    pub raw: Vec<u8>,
}

fn resolve(host: &str, port: u16) -> io::Result<Vec<SocketAddr>> {
    if let Ok(ip) = host.parse::<IpAddr>() {
        return Ok(vec![SocketAddr::new(ip, port)]);
    }
    (host, port).to_socket_addrs().map(|a| a.collect()).map_err(|_| io::Error::other("ENOTFOUND"))
}

/// connectPinned({ host, port, pin, timeoutMs }): pin None (pairing) accepts
/// whatever is presented and reports it.
pub fn connect_pinned(host: &str, port: u16, pin: Option<&Pin>, timeout_ms: u64) -> Result<Connection, NodeError> {
    let unreachable = |e: &io::Error| NodeError::new(format!("Could not reach the node ({}).", errno_name(e)), 502, "NODE_UNREACHABLE");
    let t = Duration::from_millis(timeout_ms.max(1));
    let addrs = resolve(host, port).map_err(|e| unreachable(&e))?;
    let mut last = io::Error::other("ENOTFOUND");
    let mut tcp = None;
    for a in addrs {
        match TcpStream::connect_timeout(&a, t) {
            Ok(s) => {
                tcp = Some(s);
                break;
            }
            Err(e) => last = e,
        }
    }
    let tcp = match tcp {
        Some(s) => s,
        None if is_timeout(&last) => return Err(timeout()),
        None => return Err(unreachable(&last)),
    };
    let _ = tcp.set_nodelay(true);
    let _ = tcp.set_read_timeout(Some(t));
    let _ = tcp.set_write_timeout(Some(t));
    let name = match host.parse::<IpAddr>() {
        Ok(ip) => ServerName::IpAddress(ip.into()),
        Err(_) => ServerName::try_from(host.to_string()).map_err(|_| NodeError::new("Could not reach the node (ERR_INVALID_ARG_VALUE).", 502, "NODE_UNREACHABLE"))?,
    };
    let conn = ClientConnection::new(config(), name).map_err(|e| NodeError::new(format!("Could not reach the node ({e})."), 502, "NODE_UNREACHABLE"))?;
    let other = tcp.try_clone().map_err(|e| unreachable(&e))?;
    let mut stream = StreamOwned::new(conn, tcp);
    while stream.conn.is_handshaking() {
        if let Err(e) = stream.conn.complete_io(&mut stream.sock) {
            if is_timeout(&e) {
                return Err(timeout());
            }
            return Err(unreachable(&e));
        }
    }
    let raw = stream.conn.peer_certificates().and_then(|c| c.first()).map(|c| c.as_ref().to_vec()).unwrap_or_default();
    let Some(fingerprint) = cert_fingerprint(&raw) else {
        let _ = other.shutdown(Shutdown::Both);
        return Err(NodeError::new("The node presented no certificate.", 502, "NODE_CERT"));
    };
    if let Some(p) = pin {
        if !pin_matches(p, &raw, &fingerprint, super::now_ms()) {
            let _ = other.shutdown(Shutdown::Both);
            return Err(NodeError::new("The node presented a different certificate than when it was paired. If you reset it, remove and pair it again.", 502, "NODE_CERT_CHANGED"));
        }
    }
    Ok(Connection { stream, tcp: other, fingerprint, raw })
}

/// Where a request goes.
#[derive(Debug, Clone)]
pub struct Target {
    pub host: String,
    pub port: u16,
    pub token: Option<String>,
    pub pin: Option<Pin>,
}

pub enum Body<'a> {
    None,
    Bytes(Vec<u8>),
    /// a stream of a known length; `on_end` runs once it was read to its end
    Reader { reader: Box<dyn Read + Send + 'a>, on_end: Option<Box<dyn FnOnce() + Send + 'a>> },
}

/// The head of a 200 answer handed to `on_response`.
pub struct Head {
    pub status: u16,
    pub headers: Vec<(String, String)>,
}

impl Head {
    pub fn header(&self, name: &str) -> Option<&str> {
        self.headers.iter().find(|(k, _)| k.eq_ignore_ascii_case(name)).map(|(_, v)| v.as_str())
    }
}

pub type OnResponse<'a> = Box<dyn FnOnce(&Head, &mut dyn Read) -> Result<u64, NodeError> + 'a>;

pub struct Options<'a> {
    pub method: &'a str,
    pub path: &'a str,
    pub headers: Vec<(String, String)>,
    pub body: Body<'a>,
    /// None: the target's own pin; Some(None) is never used (pairing passes its probe's)
    pub pin: Option<Pin>,
    pub timeout_ms: u64,
    pub deadline_ms: Option<u64>,
    pub on_response: Option<OnResponse<'a>>,
    pub cancel: Option<&'a Cancel>,
}

impl<'a> Options<'a> {
    pub fn get(path: &'a str, timeout_ms: u64) -> Options<'a> {
        Options { method: "GET", path, headers: vec![], body: Body::None, pin: None, timeout_ms, deadline_ms: None, on_response: None, cancel: None }
    }
}

#[derive(Debug, Clone)]
pub struct Answer {
    pub status: u16,
    /// the answer as JSON (Null when it was not JSON)
    pub json: Value,
    /// what on_response returned for a 200
    pub value: Option<u64>,
    pub fingerprint: String,
}

/// Reads an answer's body: by Content-Length, chunked, or up to the close.
enum Framing {
    Length(u64),
    Chunked { left: u64, done: bool },
    Close,
}

struct BodyReader<'r, R: BufRead> {
    inner: &'r mut R,
    framing: Framing,
}

fn premature() -> io::Error {
    io::Error::new(io::ErrorKind::ConnectionReset, "aborted")
}

fn read_line<R: BufRead>(r: &mut R, limit: usize) -> io::Result<String> {
    let mut buf = Vec::new();
    loop {
        let avail = match r.fill_buf() {
            Ok(b) => b,
            Err(e) if e.kind() == io::ErrorKind::UnexpectedEof => &[][..],
            Err(e) => return Err(e),
        };
        if avail.is_empty() {
            return Err(premature());
        }
        if let Some(i) = avail.iter().position(|&b| b == b'\n') {
            buf.extend_from_slice(&avail[..i]);
            r.consume(i + 1);
            break;
        }
        let n = avail.len();
        buf.extend_from_slice(avail);
        r.consume(n);
        if buf.len() > limit {
            return Err(io::Error::new(io::ErrorKind::InvalidData, "HPE_HEADER_OVERFLOW"));
        }
    }
    if buf.last() == Some(&b'\r') {
        buf.pop();
    }
    Ok(String::from_utf8_lossy(&buf).into_owned())
}

impl<R: BufRead> Read for BodyReader<'_, R> {
    fn read(&mut self, out: &mut [u8]) -> io::Result<usize> {
        loop {
            match &mut self.framing {
                Framing::Length(0) => return Ok(0),
                Framing::Length(left) => {
                    let want = (*left).min(out.len() as u64) as usize;
                    let n = match self.inner.read(&mut out[..want]) {
                        Ok(n) => n,
                        Err(e) if e.kind() == io::ErrorKind::UnexpectedEof => 0,
                        Err(e) => return Err(e),
                    };
                    if n == 0 {
                        return Err(premature());
                    }
                    *left -= n as u64;
                    return Ok(n);
                }
                Framing::Chunked { done: true, .. } => return Ok(0),
                Framing::Chunked { left: 0, done } => {
                    let line = read_line(self.inner, 1024)?;
                    let size = u64::from_str_radix(line.split(';').next().unwrap_or("").trim(), 16).map_err(|_| io::Error::new(io::ErrorKind::InvalidData, "HPE_INVALID_CHUNK_SIZE"))?;
                    if size == 0 {
                        // the trailers, up to the empty line
                        while !read_line(self.inner, MAX_HEADER)?.is_empty() {}
                        *done = true;
                        return Ok(0);
                    }
                    self.framing = Framing::Chunked { left: size, done: false };
                }
                Framing::Chunked { left, .. } => {
                    let want = (*left).min(out.len() as u64) as usize;
                    let n = match self.inner.read(&mut out[..want]) {
                        Ok(n) => n,
                        Err(e) if e.kind() == io::ErrorKind::UnexpectedEof => 0,
                        Err(e) => return Err(e),
                    };
                    if n == 0 {
                        return Err(premature());
                    }
                    *left -= n as u64;
                    if *left == 0 {
                        read_line(self.inner, 16)?;
                    }
                    return Ok(n);
                }
                Framing::Close => {
                    return match self.inner.read(out) {
                        Err(e) if e.kind() == io::ErrorKind::UnexpectedEof => Ok(0),
                        r => r,
                    };
                }
            }
        }
    }
}

/// A Write over the TLS stream that maps a shut socket to the reason it was shut.
fn failed(reason: &Mutex<Option<NodeError>>, e: io::Error) -> NodeError {
    if let Some(r) = reason.lock().unwrap().clone() {
        return r;
    }
    if is_timeout(&e) {
        return timeout();
    }
    NodeError::new(format!("The node connection failed ({}).", errno_name(&e)), 502, "NODE_UNREACHABLE")
}

/// request(node, { method, path, headers, body, pin, timeoutMs, deadlineMs, onResponse, signal })
pub fn request(node: &Target, o: Options) -> Result<Answer, NodeError> {
    if o.cancel.is_some_and(|c| c.aborted()) {
        return Err(NodeError::cancelled());
    }
    let pin = o.pin.clone().or_else(|| node.pin.clone());
    let Connection { mut stream, tcp, fingerprint, .. } = connect_pinned(&node.host, node.port, pin.as_ref(), o.timeout_ms)?;
    let reason: Arc<Mutex<Option<NodeError>>> = Arc::new(Mutex::new(None));
    let shut = {
        let reason = reason.clone();
        let tcp = Arc::new(tcp.try_clone().ok());
        move |why: NodeError| {
            let mut g = reason.lock().unwrap();
            if g.is_none() {
                *g = Some(why);
            }
            if let Some(t) = tcp.as_ref() {
                let _ = t.shutdown(Shutdown::Both);
            }
        }
    };
    // the overall deadline (twice the idle timeout unless given)
    let deadline = Duration::from_millis(o.deadline_ms.unwrap_or(o.timeout_ms * 2));
    let (done_tx, done_rx) = mpsc::channel::<()>();
    {
        let shut = shut.clone();
        std::thread::spawn(move || {
            if let Err(mpsc::RecvTimeoutError::Timeout) = done_rx.recv_timeout(deadline) {
                shut(NodeError::new("The node took too long.", 504, "NODE_TIMEOUT"));
            }
        });
    }
    let listener = o.cancel.map(|c| {
        let shut = shut.clone();
        c.on_abort(move || shut(NodeError::cancelled()))
    });
    let result = exchange(&mut stream, node, o.method, o.path, o.headers, o.body, o.on_response, &reason, &fingerprint);
    drop(done_tx);
    if let (Some(c), Some(id)) = (o.cancel, listener) {
        c.remove(id);
    }
    let _ = tcp.shutdown(Shutdown::Both);
    // a reason set while it ran wins (Node settles once, with the first)
    match result {
        Err(e) => Err(reason.lock().unwrap().clone().unwrap_or(e)),
        Ok(a) => Ok(a),
    }
}

#[allow(clippy::too_many_arguments)]
fn exchange(stream: &mut Tls, node: &Target, method: &str, path: &str, headers: Vec<(String, String)>, body: Body, on_response: Option<OnResponse>, reason: &Mutex<Option<NodeError>>, fingerprint: &str) -> Result<Answer, NodeError> {
    let host = if node.host.parse::<std::net::Ipv6Addr>().is_ok() { format!("[{}]:{}", node.host, node.port) } else { format!("{}:{}", node.host, node.port) };
    let mut head = format!("{method} {path} HTTP/1.1\r\nConnection: close\r\nHost: {host}\r\n");
    if let Some(t) = &node.token {
        head.push_str(&format!("Authorization: Bearer {t}\r\n"));
    }
    let has_length = headers.iter().any(|(k, _)| k.eq_ignore_ascii_case("content-length"));
    for (k, v) in &headers {
        head.push_str(&format!("{k}: {v}\r\n"));
    }
    if let Body::Bytes(b) = &body {
        if !has_length {
            head.push_str(&format!("Content-Length: {}\r\n", b.len()));
        }
    }
    head.push_str("\r\n");
    // a write that fails (the node answered early and closed) still lets its answer be read
    let mut write_err: Option<io::Error> = None;
    let mut send = |s: &mut Tls, data: &[u8]| -> bool {
        if write_err.is_some() {
            return false;
        }
        match s.write_all(data) {
            Ok(()) => true,
            Err(e) => {
                write_err = Some(e);
                false
            }
        }
    };
    if send(stream, head.as_bytes()) {
        match body {
            Body::None => {}
            Body::Bytes(b) => {
                send(stream, &b);
            }
            Body::Reader { mut reader, on_end } => {
                let mut buf = vec![0u8; 64 * 1024];
                let mut on_end = on_end;
                loop {
                    match reader.read(&mut buf) {
                        Ok(0) => {
                            if let Some(f) = on_end.take() {
                                f();
                            }
                            break;
                        }
                        Ok(n) => {
                            if !send(stream, &buf[..n]) {
                                break;
                            }
                        }
                        Err(e) => {
                            return Err(NodeError::new(format!("The node connection failed ({}).", errno_name(&e)), 502, "NODE_UNREACHABLE"));
                        }
                    }
                }
            }
        }
    }
    if write_err.is_none() {
        if let Err(e) = stream.flush() {
            write_err = Some(e);
        }
    }
    let mut r = BufReader::with_capacity(64 * 1024, stream);
    // the status line; closed before it answered: the node closed the connection
    let status_line = match read_line(&mut r, MAX_HEADER) {
        Ok(l) => l,
        Err(e) if e.kind() == io::ErrorKind::ConnectionReset && e.to_string() == "aborted" => {
            if let Some(w) = write_err {
                return Err(failed(reason, w));
            }
            if let Some(x) = reason.lock().unwrap().clone() {
                return Err(x);
            }
            return Err(NodeError::new("The node closed the connection.", 502, "NODE_UNREACHABLE"));
        }
        Err(e) => return Err(failed(reason, e)),
    };
    let mut parts = status_line.splitn(3, ' ');
    let (proto, code) = (parts.next().unwrap_or(""), parts.next().unwrap_or(""));
    let status: u16 = match (proto.starts_with("HTTP/1."), code.len() == 3, code.parse::<u16>()) {
        (true, true, Ok(s)) if s >= 100 => s,
        _ => return Err(NodeError::new("The node connection failed (HPE_INVALID_CONSTANT).", 502, "NODE_UNREACHABLE")),
    };
    let mut hdrs = Vec::new();
    let mut total = status_line.len();
    loop {
        let line = read_line(&mut r, MAX_HEADER).map_err(|e| failed(reason, e))?;
        total += line.len() + 2;
        if total > MAX_HEADER {
            return Err(NodeError::new("The node connection failed (HPE_HEADER_OVERFLOW).", 502, "NODE_UNREACHABLE"));
        }
        if line.is_empty() {
            break;
        }
        if let Some((k, v)) = line.split_once(':') {
            hdrs.push((k.trim().to_string(), v.trim().to_string()));
        }
    }
    let h = Head { status, headers: hdrs };
    let chunked = h.header("transfer-encoding").is_some_and(|v| v.to_ascii_lowercase().contains("chunked"));
    let framing = if chunked {
        Framing::Chunked { left: 0, done: false }
    } else if let Some(n) = h.header("content-length") {
        Framing::Length(n.parse().map_err(|_| NodeError::new("The node connection failed (HPE_INVALID_CONTENT_LENGTH).", 502, "NODE_UNREACHABLE"))?)
    } else {
        Framing::Close
    };
    let mut body = BodyReader { inner: &mut r, framing };
    if status == 200 {
        if let Some(f) = on_response {
            let value = f(&h, &mut body)?;
            return Ok(Answer { status, json: Value::Null, value: Some(value), fingerprint: fingerprint.to_string() });
        }
    }
    let mut data = Vec::new();
    let mut buf = [0u8; 16 * 1024];
    loop {
        match body.read(&mut buf) {
            Ok(0) => break,
            Ok(n) => {
                if data.len() + n > MAX_ANSWER {
                    return Err(NodeError::new("The node sent too much.", 502, "NODE_PROTOCOL"));
                }
                data.extend_from_slice(&buf[..n]);
            }
            Err(e) => return Err(failed(reason, e)),
        }
    }
    let json = serde_json::from_str(&String::from_utf8_lossy(&data)).unwrap_or(Value::Null);
    Ok(Answer { status, json, value: None, fingerprint: fingerprint.to_string() })
}

/// An io error inside on_response, as Node's pipeline reports it.
pub fn stream_error(e: io::Error) -> NodeError {
    if e.kind() == io::ErrorKind::ConnectionReset && e.to_string() == "aborted" {
        return NodeError::new("The node connection failed (ECONNRESET).", 502, "NODE_UNREACHABLE");
    }
    if is_timeout(&e) {
        return timeout();
    }
    NodeError::new(format!("The node connection failed ({}).", errno_name(&e)), 502, "NODE_UNREACHABLE")
}
