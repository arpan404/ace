// SPDX-License-Identifier: Apache-2.0
//! One task per accepted connection. It reads the first request head, tells an
//! upgrade candidate from an ordinary request, and hands the connection either
//! to the `UpgradeHandler` (raw: the handler owns the stream and writes the
//! pinned bytes) or to hyper's HTTP/1.1 server behind `proxy`'s service. That
//! first read is how HTTP, upgrade candidates and silent drops are told apart.
//!
//! The connection is a [`ConnIo`], never a `TcpStream` (T1b.1a): a loopback
//! listener boxes its socket, a remote listener hands over its decrypted TLS
//! stream, and everything here is the same for both. Its timers are the
//! listener's [`ConnectionLimits`], not constants.

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
use tokio_util::sync::CancellationToken;

use crate::conn_io::ConnIo;
use crate::head::{self, RequestHead};
use crate::limits::ConnectionLimits;
use crate::peer::Peer;
use crate::prefixed::{Prefixed, TimedIo, WriteTimeout};
use crate::proxy::{
    ConnectionState, ExchangeDeadline, ProxyService, ProxyTarget, RequestActivity, Stop,
};
use crate::stats::Stats;

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

/// A stream an upgrade can hand on: `Prefixed<Box<dyn ConnIo>>` on the raw
/// path, and hyper's upgraded stream on the keep-alive path.
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
        stream: Prefixed<Box<dyn ConnIo>>,
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
        stream: Prefixed<Box<dyn ConnIo>>,
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
#[allow(clippy::too_many_arguments)]
pub(crate) async fn serve(
    mut stream: Box<dyn ConnIo>,
    peer: Peer,
    target: ProxyTarget,
    upgrades: Arc<dyn UpgradeHandler>,
    shutdown: CancellationToken,
    grace: Grace,
    limits: ConnectionLimits,
    http_write: Option<Duration>,
    stats: Arc<Stats>,
) {
    let mut buf = Vec::with_capacity(1024);
    let read = tokio::select! {
        // A connection that has sent nothing is idle: closing the listener drops
        // it at once rather than waiting out the header timeout.
        _ = shutdown.cancelled() => return,
        read = tokio::time::timeout(limits.first_head, read_head(&mut stream, &mut buf)) => read,
    };
    let (head, consumed) = match read {
        Ok(ReadHead::Head(head, consumed)) => (head, consumed),
        // Node destroys the connection when the headers timeout runs out.
        Ok(ReadHead::Refused(bytes)) => return refuse(stream, bytes, limits.upgrade_write).await,
        Ok(ReadHead::Closed) | Err(_) => return,
    };

    if head::is_upgrade_candidate(&head) {
        // The handler already has the parsed head; it must not read it again, so
        // only what was read past the head is replayed.
        let rest = Bytes::copy_from_slice(&buf[consumed..]);
        let stream = Prefixed::new(rest, stream, limits.upgrade_write);
        upgrades
            .upgrade_raw(head, stream, peer, shutdown, grace)
            .await;
        return;
    }

    // hyper parses the first head itself: it gets everything the peek read.
    // A remote connection's HTTP writes are unbounded, as Node leaves them; a
    // loopback one keeps T1a's write timeout on every write. The bound is shared
    // so the upgrade handler can arm it for the `101` or a refusal, and drop it
    // again once the socket is a WebSocket (T1b.1a).
    let write = WriteTimeout::new(http_write);
    let io = Prefixed::sharing(Bytes::from(buf), stream, write.clone());
    let first_target = head.target;
    serve_hyper(
        TokioIo::new(io),
        peer,
        target,
        upgrades,
        shutdown,
        grace,
        limits,
        write,
        first_target,
        stats,
    )
    .await;
}

#[allow(clippy::too_many_arguments)]
async fn serve_hyper(
    io: TokioIo<Prefixed<Box<dyn ConnIo>>>,
    peer: Peer,
    target: ProxyTarget,
    upgrades: Arc<dyn UpgradeHandler>,
    shutdown: CancellationToken,
    grace: Grace,
    limits: ConnectionLimits,
    write: WriteTimeout,
    first_target: String,
    stats: Arc<Stats>,
) {
    let activity = RequestActivity::new();
    let deadlines = ExchangeDeadline::new();
    let service = ProxyService::new(
        target,
        upgrades,
        ConnectionState {
            peer,
            stop: Stop {
                shutdown: shutdown.clone(),
                grace,
            },
            activity: Arc::clone(&activity),
            deadlines: Arc::clone(&deadlines),
            exchange: limits.exchange,
            write,
            upgrade_write: limits.upgrade_write,
            first_target: Some(first_target),
            stats,
        },
    );

    let mut builder = hyper::server::conn::http1::Builder::new();
    builder
        .keep_alive(true)
        // A client may shut its write side down after its request and wait for
        // the answer; hyper's default would abort that upload.
        .half_close(true)
        .timer(TokioTimer::new())
        // The peek's 16 KiB cap is Node's `maxHeaderSize`, and every later head
        // on a keep-alive connection keeps the same cap (hyper's default is 408
        // KiB).
        .max_header_size(head::MAX_HEAD_BYTES)
        // Forwarded responses carry the internal server's own Date; refusals
        // carry none, as today.
        .auto_date_header(false);
    // A later head's deadline. The first head was already read under
    // `first_head`, so this only bounds the rest; `None` must be set explicitly,
    // because hyper's own default is 30 s, which would cut the SNI listener's
    // longer trusted idle window short (T1b.1a).
    builder.header_read_timeout(limits.head);
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
            // enabled: a disabled arm is never woken again. T1b.2 selects the
            // longer trusted window once a request on the connection has
            // authenticated; until then only the untrusted one applies.
            _ = activity.wait_idle(limits.keep_alive), if !closing => {
                closing = true;
                connection.as_mut().graceful_shutdown();
            }
        }
    }
}

/// Write a head refusal with the connection's write timeout, then close.
async fn refuse(stream: Box<dyn ConnIo>, bytes: &'static [u8], write_timeout: Duration) {
    let mut io = TimedIo::new(stream, write_timeout);
    let _ = io.write_all(bytes).await;
    let _ = io.flush().await;
}

#[cfg(test)]
mod tests;

enum ReadHead {
    /// A parsed head and the bytes it took.
    Head(RequestHead, usize),
    /// The bytes Node answers 400 or 431 with.
    Refused(&'static [u8]),
    /// The client closed, or the read failed, before a head arrived.
    Closed,
}

async fn read_head<S: AsyncRead + Unpin>(stream: &mut S, buf: &mut Vec<u8>) -> ReadHead {
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
