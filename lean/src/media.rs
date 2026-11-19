//! Files over HTTP: footage with Range requests (server/studioApi.js
//! sendMedia: at most 1 MiB an answer, so six cameras never hog a
//! connection). (The app's static files: ui/http.rs.)
//! Footage is opened
//! read-only, never through a symlink, and checked to be inside a vehicle's
//! folder through the open descriptor.

use axum::body::Body;
use axum::http::{header, HeaderMap, Method, Response, StatusCode};
use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::os::unix::fs::{MetadataExt, OpenOptionsExt};
use std::path::{Path, PathBuf};

pub const MEDIA_CHUNK: u64 = 1024 * 1024;
/// A whole file (footage, an export, a node's encode) is read and sent this much at a time (Node: 64 KiB);
/// on a mounted archive every read can be a round trip. Up to WIDE_STREAMS at once (about two such buffers
/// each while a client is slow); any more stream in ReaderStream's default 4 KiB, as before.
pub const STREAM_CHUNK: usize = 256 * 1024;
const WIDE_STREAMS: usize = 16;
static WIDE: tokio::sync::Semaphore = tokio::sync::Semaphore::const_new(WIDE_STREAMS);

/// The chunks of a whole file for a response body.
pub fn file_stream<R>(reader: R) -> futures_util::stream::BoxStream<'static, std::io::Result<bytes::Bytes>>
where
    R: tokio::io::AsyncRead + Send + 'static,
{
    file_stream_with(&WIDE, reader)
}

fn file_stream_with<R>(wide: &'static tokio::sync::Semaphore, reader: R) -> futures_util::stream::BoxStream<'static, std::io::Result<bytes::Bytes>>
where
    R: tokio::io::AsyncRead + Send + 'static,
{
    use futures_util::StreamExt;
    match wide.try_acquire() {
        Ok(permit) => tokio_util::io::ReaderStream::with_capacity(reader, STREAM_CHUNK)
            .map(move |chunk| {
                let _held = &permit;
                chunk
            })
            .boxed(),
        Err(_) => tokio_util::io::ReaderStream::new(reader).boxed(),
    }
}

fn media_type(p: &Path) -> &'static str {
    match p.extension().map(|e| e.to_string_lossy().to_lowercase()).as_deref() {
        Some("mp4") => "video/mp4",
        Some("mov") => "video/quicktime",
        Some("mkv") => "video/x-matroska",
        Some("avi") => "video/x-msvideo",
        Some("png") => "image/png",
        Some("jpg" | "jpeg") => "image/jpeg",
        Some("json") => "application/json",
        Some("txt" | "ass") => "text/plain; charset=utf-8",
        _ => "application/octet-stream",
    }
}

pub fn base36(mut n: u64) -> String {
    if n == 0 {
        return "0".into();
    }
    let mut s = Vec::new();
    while n > 0 {
        s.push(b"0123456789abcdefghijklmnopqrstuvwxyz"[(n % 36) as usize]);
        n /= 36;
    }
    s.reverse();
    String::from_utf8(s).unwrap()
}

/// Paths the viewer must never read: the Recycle Bin and binned files.
pub fn hidden_path(p: &str) -> bool {
    p.contains("/.sentry-recycle-bin/") || p.ends_with("/.sentry-recycle-bin") || p.ends_with(".binned")
}

/// The real path of p when it lies inside one of the roots (after symlinks), else None.
pub fn resolve_inside(p: &str, roots: &[PathBuf]) -> Option<PathBuf> {
    if p.is_empty() || p.contains('\0') || !p.starts_with('/') {
        return None;
    }
    let real = std::fs::canonicalize(p).ok()?;
    roots.iter().filter_map(|r| std::fs::canonicalize(r).ok()).any(|r| real.starts_with(&r)).then_some(real)
}

fn empty(status: StatusCode) -> Response<Body> {
    Response::builder().status(status).body(Body::empty()).unwrap()
}

/// Open a regular file read-only, not through a final symlink, and check where the descriptor really is.
fn open_confined(abs: &Path, roots: &[PathBuf]) -> Option<(File, std::fs::Metadata)> {
    let f = std::fs::OpenOptions::new().read(true).custom_flags(libc::O_NOFOLLOW).open(abs).ok()?;
    let md = f.metadata().ok()?;
    if !md.is_file() {
        return None;
    }
    use std::os::fd::AsRawFd;
    let real = std::fs::read_link(format!("/proc/self/fd/{}", f.as_raw_fd())).ok()?;
    let inside = roots.iter().filter_map(|r| std::fs::canonicalize(r).ok()).any(|r| real.starts_with(&r));
    inside.then_some((f, md))
}

/// A footage file with Range support (studioApi.js sendMedia).
pub fn send_media(method: &Method, headers: &HeaderMap, abs: &Path, roots: &[PathBuf]) -> Response<Body> {
    send_media_held::<()>(method, headers, abs, roots, || None)
}

/// send_media, and while bytes of the file are sent, what `hold` makes is kept: made only for a
/// file found and a range that can be answered, kept until a whole file streamed out is done.
pub fn send_media_held<H: Send + 'static>(method: &Method, headers: &HeaderMap, abs: &Path, roots: &[PathBuf], hold: impl FnOnce() -> Option<H>) -> Response<Body> {
    let Some((mut file, md)) = open_confined(abs, roots) else { return empty(StatusCode::NOT_FOUND) };
    let size = md.size();
    let mtime_ms = crate::scanner::ms_of(md.mtime(), md.mtime_nsec());
    let etag = format!("\"{}-{}-{}\"", base36(size), base36(mtime_ms.floor() as u64), base36(md.ino()));
    let mut start = 0u64;
    let mut end = size.saturating_sub(1);
    let mut status = StatusCode::OK;
    let mut b = Response::builder()
        .header(header::CONTENT_TYPE, media_type(abs))
        .header(header::ACCEPT_RANGES, "bytes")
        .header(header::ETAG, &etag)
        .header(header::CACHE_CONTROL, "no-cache")
        .header("X-Content-Type-Options", "nosniff");
    let range = headers.get(header::RANGE).and_then(|v| v.to_str().ok());
    let if_range = headers.get(header::IF_RANGE).and_then(|v| v.to_str().ok());
    if let Some(range) = range.filter(|_| if_range.map_or(true, |i| i == etag)) {
        let bad = || Response::builder().status(StatusCode::RANGE_NOT_SATISFIABLE).header(header::CONTENT_RANGE, format!("bytes */{size}")).body(Body::empty()).unwrap();
        let Some(spec) = range.strip_prefix("bytes=") else { return bad() };
        let Some((a, z)) = spec.split_once('-') else { return bad() };
        let digits = |s: &str| s.bytes().all(|c| c.is_ascii_digit());
        if !digits(a) || !digits(z) || (a.is_empty() && z.is_empty()) {
            return bad();
        }
        // (Number() of a long digit string: a double)
        let n = |s: &str| s.parse::<f64>().unwrap_or(f64::INFINITY);
        let mut e = end as f64;
        let s = if a.is_empty() {
            (size as f64 - n(z)).max(0.0)
        } else {
            if !z.is_empty() {
                e = e.min(n(z));
            }
            n(a)
        };
        if s > e || s >= size as f64 {
            return bad();
        }
        start = s as u64;
        end = (e as u64).min(start + MEDIA_CHUNK - 1);
        status = StatusCode::PARTIAL_CONTENT;
        b = b.header(header::CONTENT_RANGE, format!("bytes {start}-{end}/{size}"));
    }
    let len = if size == 0 { 0 } else { end - start + 1 };
    b = b.status(status).header(header::CONTENT_LENGTH, len);
    if method == Method::HEAD || size == 0 {
        return b.body(Body::empty()).unwrap();
    }
    if file.seek(SeekFrom::Start(start)).is_err() {
        return empty(StatusCode::INTERNAL_SERVER_ERROR);
    }
    let held = hold();
    if len <= MEDIA_CHUNK {
        let mut buf = vec![0u8; len as usize];
        if file.read_exact(&mut buf).is_err() {
            return empty(StatusCode::INTERNAL_SERVER_ERROR);
        }
        drop(held);
        return b.body(Body::from(buf)).unwrap();
    }
    // the whole of a big file: streamed from the descriptor that was checked
    let reader = tokio::io::AsyncReadExt::take(tokio::fs::File::from_std(file), len);
    let stream = file_stream(reader);
    let stream = match held {
        Some(h) => {
            use futures_util::StreamExt;
            stream
                .map(move |chunk| {
                    let _kept = &h;
                    chunk
                })
                .boxed()
        }
        None => stream,
    };
    b.body(Body::from_stream(stream)).unwrap()
}

#[cfg(test)]
mod stream_tests {
    use super::*;
    use futures_util::StreamExt;

    #[tokio::test]
    async fn only_so_many_whole_files_stream_in_big_chunks_at_once_the_rest_as_before() {
        static WIDE2: tokio::sync::Semaphore = tokio::sync::Semaphore::const_new(2);
        let data = vec![7u8; 600 * 1024];
        let open = || file_stream_with(&WIDE2, std::io::Cursor::new(data.clone()));
        let (mut a, mut b, mut c) = (open(), open(), open());
        assert_eq!(a.next().await.unwrap().unwrap().len(), STREAM_CHUNK);
        assert_eq!(b.next().await.unwrap().unwrap().len(), STREAM_CHUNK);
        assert_eq!(c.next().await.unwrap().unwrap().len(), 4096);
        drop(a);
        let mut d = open();
        assert_eq!(d.next().await.unwrap().unwrap().len(), STREAM_CHUNK);
        let mut total = STREAM_CHUNK;
        while let Some(chunk) = d.next().await {
            total += chunk.unwrap().len();
        }
        assert_eq!(total, data.len());
        let mut rest = 4096;
        while let Some(chunk) = c.next().await {
            rest += chunk.unwrap().len();
        }
        assert_eq!(rest, data.len());
    }

    struct Held(std::sync::Arc<std::sync::atomic::AtomicIsize>);
    impl Drop for Held {
        fn drop(&mut self) {
            self.0.fetch_sub(1, std::sync::atomic::Ordering::SeqCst);
        }
    }

    #[tokio::test]
    async fn what_a_request_holds_is_made_only_for_bytes_sent_and_kept_until_a_whole_file_has_streamed() {
        use std::sync::atomic::{AtomicIsize, AtomicUsize, Ordering};
        let dir = std::env::temp_dir().join(format!("lean-media-held-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let clip = dir.join("clip.mp4");
        std::fs::write(&clip, vec![1u8; (MEDIA_CHUNK as usize) * 3]).unwrap();
        let roots = vec![dir.clone()];
        let (live, made) = (std::sync::Arc::new(AtomicIsize::new(0)), AtomicUsize::new(0));
        let hold = || {
            made.fetch_add(1, Ordering::SeqCst);
            live.fetch_add(1, Ordering::SeqCst);
            Some(Held(live.clone()))
        };
        let range = |r: &str| {
            let mut h = HeaderMap::new();
            h.insert(header::RANGE, r.parse().unwrap());
            h
        };
        // a HEAD, a missing file and a range past the end send no footage: nothing is made
        assert_eq!(send_media_held(&Method::HEAD, &HeaderMap::new(), &clip, &roots, hold).status(), StatusCode::OK);
        assert_eq!(send_media_held(&Method::GET, &HeaderMap::new(), &dir.join("gone.mp4"), &roots, hold).status(), StatusCode::NOT_FOUND);
        assert_eq!(send_media_held(&Method::GET, &range("bytes=99999999-"), &clip, &roots, hold).status(), StatusCode::RANGE_NOT_SATISFIABLE);
        assert_eq!(made.load(Ordering::SeqCst), 0);
        // a range is sent at once: made, and let go with the answer
        assert_eq!(send_media_held(&Method::GET, &range("bytes=0-"), &clip, &roots, hold).status(), StatusCode::PARTIAL_CONTENT);
        assert_eq!((made.load(Ordering::SeqCst), live.load(Ordering::SeqCst)), (1, 0));
        // the whole file streams out: kept until the last bytes went
        let res = send_media_held(&Method::GET, &HeaderMap::new(), &clip, &roots, hold);
        assert_eq!((res.status(), live.load(Ordering::SeqCst)), (StatusCode::OK, 1));
        let mut body = res.into_body().into_data_stream();
        let mut sent = 0;
        while let Some(chunk) = body.next().await {
            assert_eq!(live.load(Ordering::SeqCst), 1, "kept while bytes go out");
            sent += chunk.unwrap().len();
        }
        drop(body);
        assert_eq!((sent, live.load(Ordering::SeqCst)), (clip.metadata().unwrap().len() as usize, 0));
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
