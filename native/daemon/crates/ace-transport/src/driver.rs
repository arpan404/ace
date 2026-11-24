// SPDX-License-Identifier: Apache-2.0
//! One task per accepted `TcpStream`. It reads the first request head, tells an
//! upgrade candidate from an ordinary request, and hands the connection either
//! to the `UpgradeHandler` (raw: the handler owns the stream and writes the
//! pinned bytes) or to hyper's HTTP/1.1 server behind `proxy`'s service. That
//! first read is how HTTP, upgrade candidates and silent drops are told apart.

use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;
use std::sync::atomic::{AtomicU8, Ordering};
use std::time::Duration;

use bytes::Bytes;
use http::Response;
use http_body_util::Full;
use hyper_util::rt::{TokioIo, TokioTimer};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio::net::TcpStream;
use tokio_util::sync::CancellationToken;

use crate::head::{self, RequestHead};
use crate::peer::Peer;
use crate::prefixed::{Prefixed, TimedIo, WRITE_TIMEOUT};
use crate::proxy::{ExchangeDeadline, ProxyService, ProxyTarget, RequestActivity, Stop};

/// Node's `headersTimeout`: a connection's request head must arrive in this.
pub const HEADERS_TIMEOUT: Duration = Duration::from_secs(60);
/// Node's `keepAliveTimeout`: an idle connection waiting on its next request
/// closes after this, once a response has finished on it.
pub const KEEP_ALIVE_TIMEOUT: Duration = Duration::from_secs(5);

/// Whether a connection may still be cancelled by the close deadline.
///
/// Every connection starts waiting. An upgrade arms it immediately before its
/// `101` is written, and the deadline cancels the connection only if it can
/// swap the same word first, so exactly one of the two wins: a `101` that has
/// begun is never cut off by a deadline, and a connection the deadline reached
/// first never starts writing.
#[derive(Clone, Default)]
pub struct Grace(Arc<AtomicU8>);

const WAITING: u8 = 0;
const WRITING: u8 = 1;
const CANCELLED: u8 = 2;

impl Grace {
    pub fn new() -> Self {
        Self::default()
    }

    /// The upgrade is writing its `101` now. False when the deadline already
    /// cancelled this connection, in which case nothing may be written.
    pub fn arm(&self) -> bool {
        self.0
            .compare_exchange(WAITING, WRITING, Ordering::AcqRel, Ordering::Acquire)
            .is_ok()
    }

    /// The close deadline passed: cancel the connection unless its upgrade armed
    /// itself first. True when the connection was cancelled.
    pub fn cancel(&self, connection: &CancellationToken) -> bool {
        if self
            .0
            .compare_exchange(WAITING, CANCELLED, Ordering::AcqRel, Ordering::Acquire)
            .is_ok()
        {
            connection.cancel();
            return true;
        }
        false
    }
}

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
        grace: Grace,
    ) -> Pin<Box<dyn Future<Output = ()> + Send>>;

    /// Later on a keep-alive connection: the same decision, answered through
    /// hyper.
    fn upgrade_hyper(
        &self,
        head: RequestHead,
        peer: Peer,
        shutdown: CancellationToken,
        grace: Grace,
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
        _grace: Grace,
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
        _grace: Grace,
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
    grace: Grace,
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
        upgrades
            .upgrade_raw(head, stream, peer, shutdown, grace)
            .await;
        return;
    }

    // hyper parses the first head itself: it gets everything the peek read.
    let io = TokioIo::new(Prefixed::new(Bytes::from(buf), stream, WRITE_TIMEOUT));
    let first_target = head.target;
    serve_hyper(io, peer, target, upgrades, shutdown, grace, first_target).await;
}

async fn serve_hyper(
    io: TokioIo<Prefixed<TcpStream>>,
    peer: Peer,
    target: ProxyTarget,
    upgrades: Arc<dyn UpgradeHandler>,
    shutdown: CancellationToken,
    grace: Grace,
    first_target: String,
) {
    let activity = RequestActivity::new();
    let deadlines = ExchangeDeadline::new();
    let service = ProxyService::new(
        target,
        upgrades,
        peer,
        Stop {
            shutdown: shutdown.clone(),
            grace,
        },
        Arc::clone(&activity),
        Arc::clone(&deadlines),
        Some(first_target),
    );

    let mut builder = hyper::server::conn::http1::Builder::new();
    builder
        .keep_alive(true)
        // A client may shut its write side down after its request and wait for
        // the answer; hyper's default would abort that upload.
        .half_close(true)
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
            // An exchange that outlived its deadline: closing the connection
            // drops the service's future and the response body, and the body's
            // guard aborts the upstream. This fires even when the body is not
            // being polled (a client blocked on a write).
            _ = deadlines.reached() => return,
            // An idle keep-alive connection closes like Node's. The head
            // deadline above already bounds the wait for the first head, and
            // every start and finish restarts this window, so the arm must stay
            // enabled: a disabled arm is never woken again.
            _ = activity.wait_idle(KEEP_ALIVE_TIMEOUT), if !closing => {
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
