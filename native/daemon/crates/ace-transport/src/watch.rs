// SPDX-License-Identifier: Apache-2.0
//! The wrapper hyper reads and writes through once the driver has seen an
//! ordinary first request. It hands every byte on unchanged, and it knows where
//! each request begins: it parses the head as it arrives and counts the body
//! that head frames, so the head of the next request is never mistaken for a
//! body's bytes.
//!
//! That knowledge is for one case Node serves and hyper cannot. Node fires
//! `upgrade` for any request that carries an `Upgrade` value and names `upgrade`
//! among its `Connection` tokens, whatever its version; hyper installs its
//! upgrade handle for HTTP/1.1 only (`hyper/proto/h1/role.rs:336`), so an
//! HTTP/1.0 upgrade that arrives later on a keep-alive connection gets an
//! `HTTP/1.0 101` with no socket to hand on. Such a head is never given to
//! hyper here: the driver takes the connection back and runs the raw upgrade
//! path with it, which writes the same `101` and hands on the same socket as
//! every other upgrade, and with the bytes read past the head as its first
//! frames.

use std::io;
use std::pin::Pin;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::task::{Context, Poll, ready};
use std::time::Duration;

use bytes::Bytes;
use http::Version;
use tokio::io::{AsyncRead, AsyncWrite, ReadBuf};
use tokio::net::TcpStream;
use tokio::sync::oneshot;

use crate::head::{self, Parsed, RequestHead};
use crate::prefixed::TimedIo;

/// A head that must take the raw upgrade path: the head itself, and the bytes
/// read past it (the first frames, which `ws` is handed as `head`).
#[derive(Debug)]
pub struct Escaped {
    /// The head, parsed from the bytes the wrapper held back.
    pub head: RequestHead,
    /// What followed that head on the wire: the socket's first bytes.
    pub rest: Bytes,
}

/// Whether the connection is still HTTP. A `101` hands it to a socket, and what
/// follows is that socket's protocol: the wrapping stops there, so HTTP framing
/// never reads a WebSocket frame as a request head.
#[derive(Clone, Debug, Default)]
pub struct Framing(Arc<AtomicBool>);

impl Framing {
    pub fn new() -> Self {
        Self::default()
    }

    /// The connection was switched to a socket: no bytes after this are heads.
    pub fn end(&self) {
        self.0.store(true, Ordering::SeqCst);
    }

    fn ended(&self) -> bool {
        self.0.load(Ordering::SeqCst)
    }
}

/// Where the connection's bytes stand between request heads.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Frame {
    /// A head begins at the front of the bytes in hand.
    Head,
    /// `remaining` bytes of the request's body still follow.
    Body(u64),
    /// The body is not one `Content-Length` delimits (a chunked body), so no
    /// later head is read: everything passes straight through.
    Lost,
}

impl Frame {
    /// The frame a head leaves behind it.
    fn after(head: &RequestHead) -> Self {
        match head::body_length(head) {
            Some(0) => Self::Head,
            Some(remaining) => Self::Body(remaining),
            None => Self::Lost,
        }
    }
}

/// The connection's socket, in a slot so the driver can take it back when a head
/// the wrapper holds belongs to the raw upgrade path instead of hyper.
#[derive(Clone, Debug)]
pub struct Socket(Arc<Mutex<Option<TcpStream>>>);

impl Socket {
    pub fn new(stream: TcpStream) -> Self {
        Self(Arc::new(Mutex::new(Some(stream))))
    }

    /// Take the socket out of the wrapper. Every later read or write through it
    /// fails, which is what ends hyper's connection; the driver owns the socket
    /// from then on.
    pub fn reclaim(&self) -> Option<TcpStream> {
        locked(&self.0).take()
    }
}

fn locked<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|poison| poison.into_inner())
}

fn taken() -> io::Error {
    io::Error::new(
        io::ErrorKind::NotConnected,
        "the connection moved to the raw upgrade path",
    )
}

impl AsyncRead for Socket {
    fn poll_read(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        let mut slot = locked(&self.0);
        match slot.as_mut() {
            Some(stream) => Pin::new(stream).poll_read(cx, buf),
            None => Poll::Ready(Err(taken())),
        }
    }
}

impl AsyncWrite for Socket {
    fn poll_write(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &[u8],
    ) -> Poll<io::Result<usize>> {
        let mut slot = locked(&self.0);
        match slot.as_mut() {
            Some(stream) => Pin::new(stream).poll_write(cx, buf),
            None => Poll::Ready(Err(taken())),
        }
    }

    fn poll_write_vectored(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        bufs: &[io::IoSlice<'_>],
    ) -> Poll<io::Result<usize>> {
        let mut slot = locked(&self.0);
        match slot.as_mut() {
            Some(stream) => Pin::new(stream).poll_write_vectored(cx, bufs),
            None => Poll::Ready(Err(taken())),
        }
    }

    fn is_write_vectored(&self) -> bool {
        locked(&self.0)
            .as_ref()
            .is_some_and(AsyncWrite::is_write_vectored)
    }

    fn poll_flush(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        let mut slot = locked(&self.0);
        match slot.as_mut() {
            Some(stream) => Pin::new(stream).poll_flush(cx),
            None => Poll::Ready(Err(taken())),
        }
    }

    /// hyper's shutdown ends its connection, not the socket's life: the driver
    /// may still write on it (the `101` of a head that arrived while the
    /// previous answer was being written), so the write side is left to the
    /// driver's own close.
    fn poll_shutdown(self: Pin<&mut Self>, _cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Poll::Ready(Ok(()))
    }
}

/// One connection's bytes, from the head the driver peeked on.
pub struct Watch {
    /// Bytes ready for hyper, oldest first: the head the driver peeked with what
    /// it read past it, or a head this wrapper parsed.
    ready: Bytes,
    /// How much of `ready` hyper has taken.
    taken: usize,
    /// Bytes read from the socket, from the current frame's position on.
    pending: Vec<u8>,
    frame: Frame,
    framing: Framing,
    reads: Socket,
    writes: TimedIo<Socket>,
    escape: Option<oneshot::Sender<Escaped>>,
}

impl Watch {
    /// Wrap a connection whose first head the driver read: `lead` holds that
    /// head and whatever followed it, of which the head takes `consumed`. Its
    /// body, if any, is counted from what came with it, and the bytes of the
    /// next head that came along are held for the framing rather than handed on.
    pub fn new(
        lead: Bytes,
        head: &RequestHead,
        consumed: usize,
        socket: Socket,
        framing: Framing,
        write_timeout: Duration,
        escape: oneshot::Sender<Escaped>,
    ) -> Self {
        let past = lead.len() - consumed;
        let (ready, pending, frame) = match head::body_length(head) {
            None => (lead, Vec::new(), Frame::Lost),
            Some(length) => {
                let body = u64::try_from(past).unwrap_or(u64::MAX).min(length);
                let end = consumed + usize::try_from(body).unwrap_or(past);
                let rest = lead[end..].to_vec();
                let frame = if body < length {
                    Frame::Body(length - body)
                } else {
                    Frame::Head
                };
                (lead.slice(..end), rest, frame)
            }
        };
        Self {
            ready,
            taken: 0,
            pending,
            frame,
            framing,
            reads: socket.clone(),
            writes: TimedIo::new(socket, write_timeout),
            escape: Some(escape),
        }
    }

    /// The connection now belongs to the raw upgrade path: send the driver the
    /// head and the bytes past it, and stop reading. hyper's connection is
    /// dropped by the driver, so nothing polls this again.
    fn escape(&mut self, head: RequestHead, consumed: usize) -> Poll<io::Result<()>> {
        let rest = Bytes::copy_from_slice(&self.pending[consumed..]);
        self.pending.clear();
        if let Some(sender) = self.escape.take() {
            let _ = sender.send(Escaped { head, rest });
        }
        Poll::Pending
    }

    /// Read more of a head into `pending`. Every byte is a head's until the head
    /// is framed, so there is no socket read to pass straight through here.
    fn read_head(&mut self, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        let room = head::MAX_HEAD_BYTES - self.pending.len();
        let mut scratch = [0u8; 4096];
        let capacity = room.min(scratch.len());
        let mut read = ReadBuf::new(&mut scratch[..capacity]);
        ready!(Pin::new(&mut self.reads).poll_read(cx, &mut read))?;
        if read.filled().is_empty() {
            // Nothing more will come: what is in hand goes on as it is, and hyper
            // answers for the head it cannot complete.
            self.frame = Frame::Lost;
            return Poll::Ready(Ok(()));
        }
        self.pending.extend_from_slice(read.filled());
        Poll::Ready(Ok(()))
    }
}

impl AsyncRead for Watch {
    fn poll_read(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        let this = self.get_mut();
        // hyper never asks for nothing; an empty request for bytes would read as
        // the end of the connection.
        if buf.remaining() == 0 {
            return Poll::Ready(Ok(()));
        }
        loop {
            if this.taken < this.ready.len() {
                let take = buf.remaining().min(this.ready.len() - this.taken);
                buf.put_slice(&this.ready[this.taken..this.taken + take]);
                this.taken += take;
                if this.taken == this.ready.len() {
                    this.ready = Bytes::new();
                    this.taken = 0;
                }
                return Poll::Ready(Ok(()));
            }

            // A `101` handed the connection to a socket: every byte from here is
            // the socket's, never a head.
            if this.framing.ended() {
                this.frame = Frame::Lost;
            }

            match this.frame {
                Frame::Head => match head::parse(&this.pending) {
                    Parsed::Head(head, consumed) => {
                        // Node fires `upgrade` for any version; hyper upgrades
                        // HTTP/1.1 only, so anything else is the raw path's.
                        if head::is_upgrade_candidate(&head) && head.version != Version::HTTP_11 {
                            return this.escape(head, consumed);
                        }
                        this.frame = Frame::after(&head);
                        this.ready = Bytes::copy_from_slice(&this.pending[..consumed]);
                        this.pending.drain(..consumed);
                    }
                    Parsed::Incomplete if this.pending.len() < head::MAX_HEAD_BYTES => {
                        ready!(this.read_head(cx))?;
                    }
                    // A head hyper answers for (431, 400), or one that is still
                    // incomplete at the cap: either way it is hyper's from here,
                    // and nothing after it is read as a head.
                    Parsed::Incomplete | Parsed::TooLarge | Parsed::Malformed => {
                        this.frame = Frame::Lost;
                    }
                },
                Frame::Body(0) => this.frame = Frame::Head,
                Frame::Body(remaining) => {
                    if this.pending.is_empty() {
                        // Nothing held back: the body's bytes go straight into
                        // hyper's own buffer, as many as the body has left.
                        let limit = usize::try_from(remaining)
                            .unwrap_or(usize::MAX)
                            .min(buf.remaining());
                        let filled = buf.initialize_unfilled();
                        let mut read = ReadBuf::new(&mut filled[..limit]);
                        ready!(Pin::new(&mut this.reads).poll_read(cx, &mut read))?;
                        let read = read.filled().len();
                        buf.advance(read);
                        this.frame = Frame::Body(remaining - read as u64);
                        return Poll::Ready(Ok(()));
                    }
                    let take = buf
                        .remaining()
                        .min(this.pending.len())
                        .min(usize::try_from(remaining).unwrap_or(usize::MAX));
                    buf.put_slice(&this.pending[..take]);
                    this.pending.drain(..take);
                    this.frame = Frame::Body(remaining - take as u64);
                    return Poll::Ready(Ok(()));
                }
                Frame::Lost => {
                    if !this.pending.is_empty() {
                        let take = buf.remaining().min(this.pending.len());
                        buf.put_slice(&this.pending[..take]);
                        this.pending.drain(..take);
                        return Poll::Ready(Ok(()));
                    }
                    return Pin::new(&mut this.reads).poll_read(cx, buf);
                }
            }
        }
    }
}

impl AsyncWrite for Watch {
    fn poll_write(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &[u8],
    ) -> Poll<io::Result<usize>> {
        Pin::new(&mut self.get_mut().writes).poll_write(cx, buf)
    }

    fn poll_write_vectored(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        bufs: &[io::IoSlice<'_>],
    ) -> Poll<io::Result<usize>> {
        Pin::new(&mut self.get_mut().writes).poll_write_vectored(cx, bufs)
    }

    fn is_write_vectored(&self) -> bool {
        self.writes.is_write_vectored()
    }

    fn poll_flush(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.get_mut().writes).poll_flush(cx)
    }

    fn poll_shutdown(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.get_mut().writes).poll_shutdown(cx)
    }
}
