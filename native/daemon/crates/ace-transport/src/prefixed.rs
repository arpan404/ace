// SPDX-License-Identifier: Apache-2.0
//! `Prefixed` hands a connection on with the bytes the driver already read, and
//! `TimedIo` bounds every write on it: a write or flush that makes no progress
//! for the connection's write timeout fails. The bound is a shared
//! [`WriteTimeout`], so the connection's upgrade handler changes the same value
//! the stream reads (T1b.1a): it is armed while a `101` or a refusal is written
//! and disarmed once a WebSocket owns the socket (T1a.2, T1a.5).

use std::io;
use std::pin::Pin;
use std::sync::{Arc, Mutex};
use std::task::{Context, Poll};
use std::time::Duration;

use bytes::Bytes;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, ReadBuf};
use tokio::time::Sleep;

/// How long a single write or flush may make no progress before the connection
/// fails. The driver passes it in; nothing else bounds a `101`.
pub const WRITE_TIMEOUT: Duration = Duration::from_secs(5);

/// How long writes may stall, shared between a connection's I/O and whoever
/// decides what is being written (T1b.1a).
///
/// `None` is unbounded: a remote connection's HTTP, whose writes Node never
/// bounds, and a live WebSocket. `Some(timeout)` bounds the next write that
/// makes no progress, which is what a `101` or a refusal gets and nothing else.
#[derive(Debug, Clone)]
pub struct WriteTimeout(Arc<Mutex<Option<Duration>>>);

impl WriteTimeout {
    pub fn new(timeout: Option<Duration>) -> Self {
        Self(Arc::new(Mutex::new(timeout)))
    }

    pub fn get(&self) -> Option<Duration> {
        *self.0.lock().unwrap_or_else(|poison| poison.into_inner())
    }

    pub fn set(&self, timeout: Option<Duration>) {
        *self.0.lock().unwrap_or_else(|poison| poison.into_inner()) = timeout;
    }
}

/// A stream whose writes and flushes are bounded by its [`WriteTimeout`], when
/// that has one. Reads pass through untouched: they are bounded by the HTTP
/// header timeout instead.
#[derive(Debug)]
pub struct TimedIo<S> {
    inner: S,
    write: WriteTimeout,
    deadline: Option<Pin<Box<Sleep>>>,
    /// The bound the armed `deadline` was built from, so a changed bound
    /// re-arms rather than keeping the old one.
    armed_with: Option<Duration>,
}

impl<S> TimedIo<S> {
    pub fn new(inner: S, timeout: Duration) -> Self {
        Self::sharing(inner, WriteTimeout::new(Some(timeout)))
    }

    /// A stream bounded by a policy its owner and its peers share.
    pub fn sharing(inner: S, write: WriteTimeout) -> Self {
        Self {
            inner,
            write,
            deadline: None,
            armed_with: None,
        }
    }

    /// Bound the writes from now on, or (`None`) let them run as long as the
    /// peer takes.
    pub fn set_timeout(&mut self, timeout: Option<Duration>) {
        self.write.set(timeout);
        self.deadline = None;
        self.armed_with = None;
    }

    /// The shared bound, for the code that decides what is being written.
    pub fn write_timeout(&self) -> WriteTimeout {
        self.write.clone()
    }

    /// The stream underneath, for the cases that write a refusal before
    /// wrapping it in `Prefixed`.
    pub fn into_inner(self) -> S {
        self.inner
    }

    /// Settle a write or flush poll: ready clears the deadline, pending arms it
    /// and fails the operation once it has run out. Unbounded, it is the inner
    /// poll untouched.
    fn bounded<T>(
        &mut self,
        cx: &mut Context<'_>,
        ready: Poll<io::Result<T>>,
    ) -> Poll<io::Result<T>> {
        let Some(timeout) = self.write.get() else {
            self.deadline = None;
            self.armed_with = None;
            return ready;
        };
        match ready {
            Poll::Ready(outcome) => {
                self.deadline = None;
                self.armed_with = None;
                Poll::Ready(outcome)
            }
            Poll::Pending => {
                if self.deadline.is_none() || self.armed_with != Some(timeout) {
                    self.deadline = Some(Box::pin(tokio::time::sleep(timeout)));
                    self.armed_with = Some(timeout);
                }
                if let Some(deadline) = self.deadline.as_mut()
                    && deadline.as_mut().poll(cx).is_ready()
                {
                    self.deadline = None;
                    self.armed_with = None;
                    return Poll::Ready(Err(io::Error::new(
                        io::ErrorKind::TimedOut,
                        "write made no progress within the connection's write timeout",
                    )));
                }
                Poll::Pending
            }
        }
    }
}

impl<S: AsyncRead + Unpin> AsyncRead for TimedIo<S> {
    fn poll_read(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        Pin::new(&mut self.get_mut().inner).poll_read(cx, buf)
    }
}

impl<S: AsyncWrite + Unpin> AsyncWrite for TimedIo<S> {
    fn poll_write(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &[u8],
    ) -> Poll<io::Result<usize>> {
        let this = self.get_mut();
        let ready = Pin::new(&mut this.inner).poll_write(cx, buf);
        this.bounded(cx, ready)
    }

    fn poll_write_vectored(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        bufs: &[io::IoSlice<'_>],
    ) -> Poll<io::Result<usize>> {
        let this = self.get_mut();
        let ready = Pin::new(&mut this.inner).poll_write_vectored(cx, bufs);
        this.bounded(cx, ready)
    }

    fn is_write_vectored(&self) -> bool {
        self.inner.is_write_vectored()
    }

    fn poll_flush(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        let this = self.get_mut();
        let ready = Pin::new(&mut this.inner).poll_flush(cx);
        this.bounded(cx, ready)
    }

    fn poll_shutdown(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.get_mut().inner).poll_shutdown(cx)
    }
}

/// A stream that yields the bytes already read before it reads the socket.
/// The driver reads the first request head to tell an upgrade candidate from an
/// ordinary request; `Prefixed` then replays what it read (the whole head for
/// hyper, which parses it itself, or only what followed it for an upgrade
/// handler that already has the parsed head) and everything after that comes
/// from the socket. Writes are bounded by [`TimedIo`].
#[derive(Debug)]
pub struct Prefixed<S> {
    prefix: Bytes,
    inner: TimedIo<S>,
}

impl<S> Prefixed<S> {
    pub fn new(prefix: Bytes, stream: S, write_timeout: Duration) -> Self {
        Self {
            prefix,
            inner: TimedIo::new(stream, write_timeout),
        }
    }

    /// A stream whose writes share `write` with its owner.
    pub fn sharing(prefix: Bytes, stream: S, write: WriteTimeout) -> Self {
        Self {
            prefix,
            inner: TimedIo::sharing(stream, write),
        }
    }

    /// Bound the writes from now on, or (`None`) leave them unbounded.
    pub fn set_write_timeout(&mut self, timeout: Option<Duration>) {
        self.inner.set_timeout(timeout);
    }

    /// The shared write bound, for the code that decides what is written.
    pub fn write_timeout(&self) -> WriteTimeout {
        self.inner.write_timeout()
    }
}

impl<S: AsyncRead + Unpin> AsyncRead for Prefixed<S> {
    fn poll_read(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        let this = self.get_mut();
        if !this.prefix.is_empty() {
            let take = this.prefix.len().min(buf.remaining());
            let chunk = this.prefix.split_to(take);
            buf.put_slice(&chunk);
            return Poll::Ready(Ok(()));
        }
        Pin::new(&mut this.inner).poll_read(cx, buf)
    }
}

impl<S: AsyncRead + Unpin> Prefixed<S> {
    /// Waits until the client's read side closes, without losing a byte: the
    /// one byte a client that is still there has sent is held in the prefix,
    /// which every read yields first, so a client that sent early is read
    /// exactly as if nothing had been peeked. This is how the driver tells a
    /// client that went away from one still waiting while its upgrade is being
    /// decided.
    pub async fn peer_closed(&mut self) -> bool {
        if !self.prefix.is_empty() {
            // Bytes already read are a client that sent more, not one that left.
            return false;
        }
        let mut byte = [0u8; 1];
        loop {
            match self.inner.read(&mut byte).await {
                Ok(0) => return true,
                Ok(_) => {
                    self.prefix = Bytes::copy_from_slice(&byte[..1]);
                    return false;
                }
                Err(error) if error.kind() == io::ErrorKind::Interrupted => {}
                Err(_) => return true,
            }
        }
    }
}

impl<S: AsyncWrite + Unpin> AsyncWrite for Prefixed<S> {
    fn poll_write(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &[u8],
    ) -> Poll<io::Result<usize>> {
        Pin::new(&mut self.get_mut().inner).poll_write(cx, buf)
    }

    fn poll_write_vectored(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        bufs: &[io::IoSlice<'_>],
    ) -> Poll<io::Result<usize>> {
        Pin::new(&mut self.get_mut().inner).poll_write_vectored(cx, bufs)
    }

    fn is_write_vectored(&self) -> bool {
        self.inner.is_write_vectored()
    }

    fn poll_flush(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.get_mut().inner).poll_flush(cx)
    }

    fn poll_shutdown(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.get_mut().inner).poll_shutdown(cx)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    use std::future::poll_fn;
    use std::time::Duration;

    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpStream;

    /// A stream that never accepts a byte and never ends.
    struct Stuck;

    impl AsyncRead for Stuck {
        fn poll_read(
            self: Pin<&mut Self>,
            _cx: &mut Context<'_>,
            _buf: &mut ReadBuf<'_>,
        ) -> Poll<io::Result<()>> {
            Poll::Pending
        }
    }

    impl AsyncWrite for Stuck {
        fn poll_write(
            self: Pin<&mut Self>,
            _cx: &mut Context<'_>,
            _buf: &[u8],
        ) -> Poll<io::Result<usize>> {
            Poll::Pending
        }

        fn poll_flush(self: Pin<&mut Self>, _cx: &mut Context<'_>) -> Poll<io::Result<()>> {
            Poll::Pending
        }

        fn poll_shutdown(self: Pin<&mut Self>, _cx: &mut Context<'_>) -> Poll<io::Result<()>> {
            Poll::Ready(Ok(()))
        }
    }

    /// A stream that accepts everything at once.
    struct Accepts;

    impl AsyncRead for Accepts {
        fn poll_read(
            self: Pin<&mut Self>,
            _cx: &mut Context<'_>,
            _buf: &mut ReadBuf<'_>,
        ) -> Poll<io::Result<()>> {
            Poll::Ready(Ok(()))
        }
    }

    impl AsyncWrite for Accepts {
        fn poll_write(
            self: Pin<&mut Self>,
            _cx: &mut Context<'_>,
            buf: &[u8],
        ) -> Poll<io::Result<usize>> {
            Poll::Ready(Ok(buf.len()))
        }

        fn poll_flush(self: Pin<&mut Self>, _cx: &mut Context<'_>) -> Poll<io::Result<()>> {
            Poll::Ready(Ok(()))
        }

        fn poll_shutdown(self: Pin<&mut Self>, _cx: &mut Context<'_>) -> Poll<io::Result<()>> {
            Poll::Ready(Ok(()))
        }
    }

    #[tokio::test]
    async fn a_write_that_stalls_fails_after_the_write_timeout() {
        // The timeout is the driver's to choose, so the test chooses a short one.
        let mut io = TimedIo::new(Stuck, Duration::from_millis(20));
        let write = poll_fn(|cx| Pin::new(&mut io).poll_write(cx, b"hello"));
        let outcome = tokio::time::timeout(Duration::from_secs(1), write)
            .await
            .expect("the write timeout fires long before the test's own bound");
        let error = outcome.expect_err("a stalled write never succeeds");
        assert_eq!(error.kind(), io::ErrorKind::TimedOut);
    }

    #[tokio::test]
    async fn a_write_that_makes_progress_is_not_timed_out() {
        let mut io = TimedIo::new(Accepts, WRITE_TIMEOUT);
        io.write_all(b"hello")
            .await
            .expect("an accepting stream takes every byte");
        io.flush().await.expect("an accepting stream flushes");
    }

    #[tokio::test]
    async fn prefixed_yields_what_was_read_before_the_socket() {
        let (near, mut far) = tokio::io::duplex(16);
        far.write_all(b"def").await.expect("duplex takes bytes");
        let mut io = Prefixed::new(Bytes::from_static(b"abc"), near, WRITE_TIMEOUT);

        let mut got = [0u8; 2];
        io.read_exact(&mut got)
            .await
            .expect("the prefix fills two bytes");
        assert_eq!(&got, b"ab");

        let mut rest = [0u8; 4];
        io.read_exact(&mut rest)
            .await
            .expect("the rest spans prefix and socket");
        assert_eq!(&rest, b"cdef");
    }

    #[tokio::test]
    async fn a_client_that_goes_away_is_seen_and_its_bytes_are_left_to_read() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("a loopback listener");
        let addr = listener.local_addr().expect("its address");
        let mut client = TcpStream::connect(addr).await.expect("a loopback client");
        let (accepted, _) = listener.accept().await.expect("an accepted socket");
        let mut io = Prefixed::new(Bytes::new(), accepted, WRITE_TIMEOUT);

        assert!(
            tokio::time::timeout(Duration::from_millis(50), io.peer_closed())
                .await
                .is_err(),
            "a client that is still there is not gone"
        );
        client
            .write_all(b"x")
            .await
            .expect("the client sends a byte");
        assert!(
            !io.peer_closed().await,
            "a client with bytes waiting is present, not gone"
        );
        let mut byte = [0u8; 1];
        io.read_exact(&mut byte)
            .await
            .expect("the peek took nothing from the stream");
        assert_eq!(&byte, b"x");

        drop(client);
        assert!(
            tokio::time::timeout(Duration::from_secs(2), io.peer_closed())
                .await
                .expect("the closed client is noticed"),
            "a client that went away is gone"
        );
    }

    #[tokio::test]
    async fn prefixed_writes_go_to_the_socket() {
        let (near, mut far) = tokio::io::duplex(16);
        let mut io = Prefixed::new(Bytes::from_static(b"abc"), near, WRITE_TIMEOUT);
        io.write_all(b"out").await.expect("duplex takes bytes");
        io.flush().await.expect("duplex flushes");

        let mut got = [0u8; 3];
        far.read_exact(&mut got)
            .await
            .expect("the write reached the socket");
        assert_eq!(&got, b"out");
    }
}
