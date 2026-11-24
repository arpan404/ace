// SPDX-License-Identifier: Apache-2.0
//! One unmasked FIN frame per message, its header and payload as one buffer and
//! one write, flushed per message. The server never fragments and never masks
//! (RFC 6455 §5.1); lengths use the shortest of the three encodings.

use std::io;
use std::pin::Pin;
use std::task::{Context, Poll};

use futures_util::Sink;
use tokio::io::AsyncWrite;

use super::Outbound;

/// The wire, one frame at a time. The encoded bytes live in one buffer that is
/// reused for the connection's whole life.
pub struct FrameWriter<W> {
    io: W,
    pending: Vec<u8>,
    written: usize,
}

impl<W> FrameWriter<W> {
    pub fn new(io: W) -> Self {
        Self {
            io,
            pending: Vec::with_capacity(1024),
            written: 0,
        }
    }
}

/// The header for `length`, with the shortest length encoding that holds it.
fn header(fin: bool, rsv1: bool, opcode: u8, length: usize, out: &mut Vec<u8>) {
    out.push((if fin { 0x80 } else { 0 }) | (if rsv1 { 0x40 } else { 0 }) | (opcode & 0x0f));
    if length <= 125 {
        out.push(length as u8);
    } else if length <= u16::MAX as usize {
        out.push(126);
        out.extend_from_slice(&(length as u16).to_be_bytes());
    } else {
        out.push(127);
        out.extend_from_slice(&(length as u64).to_be_bytes());
    }
}

/// Writes the whole pending frame, however many polls it takes.
fn flush_pending<W: AsyncWrite + Unpin>(
    io: &mut W,
    pending: &[u8],
    written: &mut usize,
    cx: &mut Context<'_>,
) -> Poll<Result<(), io::Error>> {
    while *written < pending.len() {
        match Pin::new(&mut *io).poll_write(cx, &pending[*written..]) {
            Poll::Pending => return Poll::Pending,
            Poll::Ready(Ok(0)) => {
                return Poll::Ready(Err(io::Error::new(
                    io::ErrorKind::WriteZero,
                    "the connection accepted no bytes",
                )));
            }
            Poll::Ready(Ok(count)) => *written += count,
            Poll::Ready(Err(error)) => return Poll::Ready(Err(error)),
        }
    }
    Poll::Ready(Ok(()))
}

impl<W: AsyncWrite + Unpin> Sink<Outbound> for FrameWriter<W> {
    type Error = io::Error;

    fn poll_ready(self: Pin<&mut Self>, _cx: &mut Context<'_>) -> Poll<Result<(), Self::Error>> {
        Poll::Ready(Ok(()))
    }

    fn start_send(self: Pin<&mut Self>, item: Outbound) -> Result<(), Self::Error> {
        let this = self.get_mut();
        // A partly written frame must be finished (or the stream dropped) before
        // another frame begins: appending here would interleave the two on the
        // wire and restart the write at byte zero.
        if !this.pending.is_empty() {
            return Err(io::Error::other("a frame is still in flight"));
        }
        header(
            true,
            item.rsv1,
            item.opcode.code(),
            item.payload.len(),
            &mut this.pending,
        );
        this.pending.extend_from_slice(&item.payload);
        this.written = 0;
        Ok(())
    }

    fn poll_flush(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Result<(), Self::Error>> {
        let this = self.get_mut();
        match flush_pending(&mut this.io, &this.pending, &mut this.written, cx) {
            Poll::Pending => Poll::Pending,
            Poll::Ready(Err(error)) => Poll::Ready(Err(error)),
            Poll::Ready(Ok(())) => {
                this.pending.clear();
                this.written = 0;
                Pin::new(&mut this.io).poll_flush(cx)
            }
        }
    }

    fn poll_close(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Result<(), Self::Error>> {
        let this = self.get_mut();
        match flush_pending(&mut this.io, &this.pending, &mut this.written, cx) {
            Poll::Pending => Poll::Pending,
            Poll::Ready(Err(error)) => Poll::Ready(Err(error)),
            Poll::Ready(Ok(())) => {
                this.pending.clear();
                this.written = 0;
                match Pin::new(&mut this.io).poll_flush(cx) {
                    Poll::Pending => Poll::Pending,
                    Poll::Ready(Err(error)) => Poll::Ready(Err(error)),
                    Poll::Ready(Ok(())) => Pin::new(&mut this.io).poll_shutdown(cx),
                }
            }
        }
    }
}
