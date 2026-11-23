// SPDX-License-Identifier: Apache-2.0
//! One task per accepted `TcpStream`. It reads the first request head, tells an
//! upgrade candidate from an ordinary request, and hands the connection either
//! to the `UpgradeHandler` (raw: the handler owns the stream and writes the
//! pinned bytes) or to hyper's HTTP/1.1 server behind `proxy`'s service. That
//! first read is how HTTP, upgrade candidates and silent drops are told apart.

use std::future::Future;
use std::mem::MaybeUninit;
use std::pin::Pin;
use std::sync::Arc;
use std::time::Duration;

use bytes::Bytes;
use http::Response;
use http_body_util::Full;
use hyper_util::rt::{TokioIo, TokioTimer};
use socket2::SockRef;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio::net::TcpStream;
use tokio_util::sync::CancellationToken;

use crate::head::{self, RequestHead};
use crate::peer::Peer;
use crate::prefixed::{Prefixed, TimedIo, WRITE_TIMEOUT};
use crate::proxy::{ProxyService, ProxyTarget, RequestActivity, UploadWatch};

/// Node's `headersTimeout`: a connection's request head must arrive in this.
pub const HEADERS_TIMEOUT: Duration = Duration::from_secs(60);
/// Node's `keepAliveTimeout`: an idle connection waiting on its next request
/// closes after this, once a response has finished on it.
pub const KEEP_ALIVE_TIMEOUT: Duration = Duration::from_secs(5);
/// How long the client-socket watch waits between peeks while the client's
/// unread bytes are queued.
const CLOSE_PEEK: Duration = Duration::from_millis(200);
/// How long a client's end of input is given to turn out to be a half-close
/// after a complete request rather than a departure.
const CLOSE_GRACE: Duration = Duration::from_secs(1);

/// A stream an upgrade can hand on: `Prefixed<TcpStream>` on the raw path, and
/// hyper's upgraded stream on the keep-alive path.
pub trait UpgradeIo: AsyncRead + AsyncWrite + Unpin + Send + 'static {}

impl<T: AsyncRead + AsyncWrite + Unpin + Send + 'static> UpgradeIo for T {}

/// What an upgrade candidate on a keep-alive connection gets.
pub enum UpgradeReply {
    /// Close the connection with no bytes (the silent drop).
    Drop,
    /// The handler's pinned refusal, written by hyper: status, fields and body.
    Refuse(Response<Full<Bytes>>),
    /// The `101`, and the capacity reservation the upgrade spends.
    Switch(Response<Full<Bytes>>, u64),
}

/// What owns an upgrade candidate. T1a.2's only implementation is
/// [`RefuseUpgrades`]; T1a.3 replaces it with the WebSocket handshake.
pub trait UpgradeHandler: Send + Sync + 'static {
    /// First on a connection: the handler owns the raw stream from here and
    /// writes the pinned bytes itself, straight to the socket.
    fn upgrade_raw(
        &self,
        head: RequestHead,
        stream: Prefixed<TcpStream>,
        peer: Peer,
        shutdown: CancellationToken,
    ) -> Pin<Box<dyn Future<Output = ()> + Send>>;

    /// Later on a keep-alive connection: the same decision, answered through
    /// hyper.
    fn upgrade_hyper(
        &self,
        head: RequestHead,
        peer: Peer,
        shutdown: CancellationToken,
    ) -> Pin<Box<dyn Future<Output = UpgradeReply> + Send>>;

    /// After a `Switch` reply: hyper's upgrade resolved (`Some`) or failed
    /// (`None`).
    fn switched(&self, reservation: u64, stream: Option<Box<dyn UpgradeIo>>);
}

/// Closes an upgrade candidate with no answer, as a path the daemon does not
/// serve does today.
pub struct RefuseUpgrades;

impl UpgradeHandler for RefuseUpgrades {
    fn upgrade_raw(
        &self,
        _head: RequestHead,
        stream: Prefixed<TcpStream>,
        _peer: Peer,
        _shutdown: CancellationToken,
    ) -> Pin<Box<dyn Future<Output = ()> + Send>> {
        Box::pin(async move {
            // Dropping the stream closes it with no bytes written.
            drop(stream);
        })
    }

    fn upgrade_hyper(
        &self,
        _head: RequestHead,
        _peer: Peer,
        _shutdown: CancellationToken,
    ) -> Pin<Box<dyn Future<Output = UpgradeReply> + Send>> {
        Box::pin(async move { UpgradeReply::Drop })
    }

    fn switched(&self, _reservation: u64, stream: Option<Box<dyn UpgradeIo>>) {
        drop(stream);
    }
}

/// Serve one accepted connection until it closes.
pub(crate) async fn serve(
    mut stream: TcpStream,
    peer: Peer,
    target: ProxyTarget,
    upgrades: Arc<dyn UpgradeHandler>,
    shutdown: CancellationToken,
) {
    let mut buf = Vec::with_capacity(1024);
    let read = tokio::select! {
        // A connection that has sent nothing is idle: closing the listener drops
        // it at once rather than waiting out the header timeout.
        _ = shutdown.cancelled() => return,
        read = tokio::time::timeout(HEADERS_TIMEOUT, read_head(&mut stream, &mut buf)) => read,
    };
    let (head, consumed) = match read {
        Ok(ReadHead::Head(head, consumed)) => (head, consumed),
        // Node destroys the connection when the headers timeout runs out.
        Ok(ReadHead::Refused(bytes)) => return refuse(stream, bytes).await,
        Ok(ReadHead::Closed) | Err(_) => return,
    };

    if head::is_upgrade_candidate(&head) {
        // The handler already has the parsed head; it must not read it again, so
        // only what was read past the head is replayed.
        let rest = Bytes::copy_from_slice(&buf[consumed..]);
        let stream = Prefixed::new(rest, stream, WRITE_TIMEOUT);
        upgrades.upgrade_raw(head, stream, peer, shutdown).await;
        return;
    }

    // The upload watch needs a second handle on the client's socket; without one
    // the connection cannot be watched and is not served.
    let Some((stream, watch)) = duplicate(stream) else {
        return;
    };
    let upload = UploadWatch::new();
    let finished = CancellationToken::new();
    if let Some(watch) = watch {
        tokio::spawn(watch_client_close(watch, upload.clone(), finished.clone()));
    }
    // Cancelled however this connection ends, a returned future or an aborted
    // task alike, so the watch never outlives the socket.
    let _finished_guard = finished.clone().drop_guard();

    // hyper parses the first head itself: it gets everything the peek read.
    let io = TokioIo::new(Prefixed::new(Bytes::from(buf), stream, WRITE_TIMEOUT));
    let first_target = head.target;
    serve_hyper(io, peer, target, upgrades, shutdown, upload, first_target).await;
}

async fn serve_hyper(
    io: TokioIo<Prefixed<TcpStream>>,
    peer: Peer,
    target: ProxyTarget,
    upgrades: Arc<dyn UpgradeHandler>,
    shutdown: CancellationToken,
    upload: UploadWatch,
    first_target: String,
) {
    let activity = RequestActivity::new();
    let service = ProxyService::new(
        target,
        upgrades,
        peer,
        shutdown.clone(),
        Arc::clone(&activity),
        upload,
        Some(first_target),
    );

    let mut builder = hyper::server::conn::http1::Builder::new();
    builder
        .keep_alive(true)
        .timer(TokioTimer::new())
        .header_read_timeout(HEADERS_TIMEOUT)
        // The peek's 16 KiB cap is Node's `maxHeaderSize`, and every later head
        // on a keep-alive connection keeps the same cap (hyper's default is 408
        // KiB).
        .max_header_size(head::MAX_HEAD_BYTES)
        // Forwarded responses carry the internal server's own Date; refusals
        // carry none, as today.
        .auto_date_header(false);
    let connection = builder.serve_connection(io, service).with_upgrades();
    tokio::pin!(connection);

    let mut closing = false;
    loop {
        tokio::select! {
            outcome = connection.as_mut() => {
                drop(outcome);
                return;
            }
            _ = shutdown.cancelled(), if !closing => {
                closing = true;
                connection.as_mut().graceful_shutdown();
            }
            // An idle keep-alive connection closes like Node's; a connection
            // that never answered is the header timeout's.
            _ = activity.wait_idle(KEEP_ALIVE_TIMEOUT), if !closing && activity.completed_any() => {
                closing = true;
                connection.as_mut().graceful_shutdown();
            }
        }
    }
}

/// Write a head refusal with the connection's write timeout, then close.
async fn refuse(stream: TcpStream, bytes: &'static [u8]) {
    let mut io = TimedIo::new(stream, WRITE_TIMEOUT);
    let _ = io.write_all(bytes).await;
    let _ = io.flush().await;
}

/// The connection's stream and a second handle on the same socket, for the
/// client-socket watch. A kernel that refuses the duplicate ends the connection:
/// without the second handle a client that goes away mid-upload would wait out
/// the exchange deadline.
fn duplicate(stream: TcpStream) -> Option<(TcpStream, Option<TcpStream>)> {
    let std = stream.into_std().ok()?;
    let watch = std.try_clone().ok();
    let primary = TcpStream::from_std(std).ok()?;
    let watch = watch.and_then(|watch| TcpStream::from_std(watch).ok());
    Some((primary, watch))
}

/// Poll a second handle on the client's socket for its end of input, so a
/// client that goes away while its upload is backpressured is seen instead of
/// waiting out the exchange deadline.
///
/// A client that half-closes after a complete request is not gone, and the
/// kernel cannot tell the two apart: an end of input is only visible once the
/// queued bytes are gone, and the last frames of a complete body can still be
/// on their way. So an end of input only counts as a departure when the request
/// body has not ended, and not even then within [`CLOSE_GRACE`].
async fn watch_client_close(stream: TcpStream, upload: UploadWatch, finished: CancellationToken) {
    let mut byte = [MaybeUninit::<u8>::uninit()];
    loop {
        match SockRef::from(&stream).peek(&mut byte) {
            Ok(0) => break,
            // Bytes are queued; nothing more can be learned until they move.
            Ok(_) => {
                tokio::select! {
                    _ = finished.cancelled() => return,
                    _ = tokio::time::sleep(CLOSE_PEEK) => {}
                }
            }
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                tokio::select! {
                    _ = finished.cancelled() => return,
                    ready = stream.readable() => {
                        if ready.is_err() {
                            break;
                        }
                    }
                }
            }
            Err(_) => break,
        }
    }

    if upload.has_ended() {
        return;
    }
    tokio::select! {
        _ = finished.cancelled() => return,
        _ = tokio::time::sleep(CLOSE_GRACE) => {}
    }
    if !upload.has_ended() {
        upload.cancel();
    }
}

enum ReadHead {
    /// A parsed head and the bytes it took.
    Head(RequestHead, usize),
    /// The bytes Node answers 400 or 431 with.
    Refused(&'static [u8]),
    /// The client closed, or the read failed, before a head arrived.
    Closed,
}

async fn read_head(stream: &mut TcpStream, buf: &mut Vec<u8>) -> ReadHead {
    loop {
        match head::parse(buf) {
            head::Parsed::Head(head, consumed) => return ReadHead::Head(head, consumed),
            head::Parsed::TooLarge => return ReadHead::Refused(head::TOO_LARGE),
            head::Parsed::Malformed => return ReadHead::Refused(head::BAD_REQUEST),
            head::Parsed::Incomplete => {}
        }

        let room = head::MAX_HEAD_BYTES.saturating_sub(buf.len());
        let mut chunk = vec![0u8; room.min(8192)];
        match stream.read(&mut chunk).await {
            Ok(0) => return ReadHead::Closed,
            Ok(read) => buf.extend_from_slice(&chunk[..read]),
            Err(error) if error.kind() == std::io::ErrorKind::Interrupted => {}
            Err(_) => return ReadHead::Closed,
        }
    }
}
