// SPDX-License-Identifier: Apache-2.0
//! `Prefixed` hands a connection on with the bytes the driver already read, and
//! `TimedIo` bounds every write on it: a write or flush that makes no progress
//! for the connection's write timeout fails, which is the only timeout on a
//! WebSocket `101` (T1a.2, T1a.5).

use std::io;
use std::pin::Pin;
use std::task::{Context, Poll};
use std::time::Duration;

use bytes::Bytes;
use tokio::io::{AsyncRead, AsyncWrite, ReadBuf};
use tokio::time::Sleep;

/// How long a single write or flush may make no progress before the connection
/// fails. The driver passes it in; nothing else bounds a `101`.
pub const WRITE_TIMEOUT: Duration = Duration::from_secs(5);

/// A stream whose writes and flushes are bounded by `timeout`. Reads pass
/// through untouched: they are bounded by the HTTP header timeout instead.
#[derive(Debug)]
pub struct TimedIo<S> {
    inner: S,
    timeout: Duration,
    deadline: Option<Pin<Box<Sleep>>>,
}

impl<S> TimedIo<S> {
    pub fn new(inner: S, timeout: Duration) -> Self {
        Self {
            inner,
            timeout,
            deadline: None,
        }
    }

    /// The stream underneath, for the cases that write a refusal before
    /// wrapping it in `Prefixed`.
    pub fn into_inner(self) -> S {
        self.inner
    }

    /// Settle a write or flush poll: ready clears the deadline, pending arms it
    /// and fails the operation once it has run out.
    fn bounded<T>(
        &mut self,
        cx: &mut Context<'_>,
        ready: Poll<io::Result<T>>,
    ) -> Poll<io::Result<T>> {
        match ready {
            Poll::Ready(outcome) => {
                self.deadline = None;
                Poll::Ready(outcome)
            }
            Poll::Pending => {
                if self.deadline.is_none() {
                    let timeout = self.timeout;
                    self.deadline = Some(Box::pin(tokio::time::sleep(timeout)));
                }
                if let Some(deadline) = self.deadline.as_mut()
                    && deadline.as_mut().poll(cx).is_ready()
                {
                    self.deadline = None;
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
