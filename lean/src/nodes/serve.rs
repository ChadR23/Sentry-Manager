//! A small HTTPS/1.1 server for `/node/v1/*`: what the tests and the parity
//! runs serve the worker with, and an example of what core does with it
//! (core serves the worker from its own HTTPS server: build a
//! `WorkerRequest` with the served certificate, write the `WorkerReply`,
//! call `delivered()` once the answer is all written).

use super::worker::{ReplyBody, WorkerReply, WorkerRequest};
use rustls::pki_types::pem::PemObject;
use rustls::pki_types::{CertificateDer, PrivateKeyDer};
use rustls::{ServerConfig, ServerConnection, StreamOwned};
use std::io::{self, BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

pub type Handler = Arc<dyn Fn(&mut WorkerRequest) -> WorkerReply + Send + Sync>;

pub struct Server {
    pub port: u16,
    stop: Arc<AtomicBool>,
}

impl Server {
    pub fn close(&self) {
        self.stop.store(true, Ordering::SeqCst);
        let _ = TcpStream::connect(("127.0.0.1", self.port));
    }
}

impl Drop for Server {
    fn drop(&mut self) {
        self.close();
    }
}

/// Serves `handler` on 127.0.0.1:`port` (0: any free port) with the PEM certificate and key.
pub fn serve(cert_pem: &[u8], key_pem: &[u8], port: u16, handler: Handler) -> io::Result<Server> {
    let certs: Vec<CertificateDer<'static>> = CertificateDer::pem_slice_iter(cert_pem).collect::<Result<_, _>>().map_err(io::Error::other)?;
    let key = PrivateKeyDer::from_pem_slice(key_pem).map_err(io::Error::other)?;
    let served = certs.first().map(|c| c.as_ref().to_vec()).unwrap_or_default();
    let provider = Arc::new(rustls::crypto::ring::default_provider());
    let mut config = ServerConfig::builder_with_provider(provider).with_protocol_versions(&[&rustls::version::TLS13, &rustls::version::TLS12]).map_err(io::Error::other)?
        .with_no_client_auth().with_single_cert(certs, key).map_err(io::Error::other)?;
    config.alpn_protocols = vec![b"http/1.1".to_vec()];
    let config = Arc::new(config);
    let listener = TcpListener::bind(("127.0.0.1", port))?;
    let port = listener.local_addr()?.port();
    let stop = Arc::new(AtomicBool::new(false));
    let s = stop.clone();
    let served = Arc::new(served);
    std::thread::spawn(move || {
        for conn in listener.incoming() {
            if s.load(Ordering::SeqCst) {
                break;
            }
            let Ok(tcp) = conn else { continue };
            let (config, handler, served) = (config.clone(), handler.clone(), served.clone());
            std::thread::spawn(move || {
                let _ = one(tcp, config, handler, &served);
            });
        }
    });
    Ok(Server { port, stop })
}

fn one(tcp: TcpStream, config: Arc<ServerConfig>, handler: Handler, served: &[u8]) -> io::Result<()> {
    let address = tcp.peer_addr().map(|a| a.ip().to_string()).unwrap_or_default();
    let address = address.strip_prefix("::ffff:").unwrap_or(&address).to_string();
    tcp.set_read_timeout(Some(std::time::Duration::from_secs(120)))?;
    let conn = ServerConnection::new(config).map_err(io::Error::other)?;
    let mut tls = StreamOwned::new(conn, tcp);
    let mut r = BufReader::new(&mut tls);
    let mut line = String::new();
    r.read_line(&mut line)?;
    let mut parts = line.trim_end().splitn(3, ' ');
    let (method, target) = (parts.next().unwrap_or("").to_string(), parts.next().unwrap_or("").to_string());
    let mut headers = Vec::new();
    loop {
        let mut h = String::new();
        if r.read_line(&mut h)? == 0 {
            return Ok(());
        }
        let h = h.trim_end();
        if h.is_empty() {
            break;
        }
        if let Some((k, v)) = h.split_once(':') {
            headers.push((k.trim().to_string(), v.trim().to_string()));
        }
    }
    let length: u64 = headers.iter().find(|(k, _)| k.eq_ignore_ascii_case("content-length")).and_then(|(_, v)| v.parse().ok()).unwrap_or(0);
    let path = target.split('?').next().unwrap_or("").to_string();
    let mut body = (&mut r).take(length);
    let reply = {
        let mut req = WorkerRequest { method: &method, path: &path, headers: &headers, address: &address, served_cert: Some(served), body: &mut body };
        handler(&mut req)
    };
    // what was not read of the body is drained (closing with it unread resets the
    // connection, and the main would never see the answer)
    let began = std::time::Instant::now();
    let mut sink = [0u8; 64 * 1024];
    while began.elapsed() < std::time::Duration::from_secs(5) {
        match body.read(&mut sink) {
            Ok(0) | Err(_) => break,
            Ok(_) => {}
        }
    }
    drop(body);
    drop(r);
    if matches!(reply.body, ReplyBody::Close) {
        return Ok(());
    }
    let mut head = format!("HTTP/1.1 {} {}\r\nConnection: close\r\n", reply.status, reason(reply.status));
    for (k, v) in &reply.headers {
        head.push_str(&format!("{k}: {v}\r\n"));
    }
    head.push_str("\r\n");
    let mut reply = reply;
    let written = (|| -> io::Result<()> {
        tls.write_all(head.as_bytes())?;
        match &mut reply.body {
            ReplyBody::Bytes(b) => tls.write_all(b)?,
            ReplyBody::File(f, _) => {
                io::copy(f, &mut tls)?;
            }
            ReplyBody::Close => {}
        }
        tls.flush()?;
        tls.conn.send_close_notify();
        tls.flush()
    })();
    if written.is_ok() {
        reply.delivered();
    }
    Ok(())
}

pub fn reason(status: u16) -> &'static str {
    match status {
        200 => "OK",
        400 => "Bad Request",
        401 => "Unauthorized",
        403 => "Forbidden",
        404 => "Not Found",
        405 => "Method Not Allowed",
        409 => "Conflict",
        411 => "Length Required",
        413 => "Payload Too Large",
        415 => "Unsupported Media Type",
        429 => "Too Many Requests",
        500 => "Internal Server Error",
        503 => "Service Unavailable",
        507 => "Insufficient Storage",
        _ => "",
    }
}

