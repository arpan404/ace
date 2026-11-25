// SPDX-License-Identifier: Apache-2.0
//! The wire's frames, one at a time, over the connection's read half. The reader
//! owns the assembler so the length check happens against the message already in
//! flight, before a payload is read; the driver feeds each frame back to that
//! same assembler after it decides what the frame is.

use std::pin::Pin;
use std::task::{Context, Poll};

use bytes::{Buf, BytesMut};
use futures_util::Stream;
use tokio::io::{AsyncRead, ReadBuf};

use super::assemble::{Assembler, MessageBody, Plain};
use super::header::{First, extended_len, parse_first, payload_length};
use super::{Frame, FrameError, FrameLimits};

/// One read buffer per connection: every fill appends here and every frame is
/// consumed from it, so a frame does not allocate its own read buffer.
pub(crate) const READ_CHUNK: usize = 8 * 1024;

/// What the end of the connection found at the front of the buffer.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Front {
    /// The whole frame is buffered: parsing it needs no read.
    Whole,
    /// Only part of it is buffered, and the rest can never arrive.
    Partial,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum State {
    /// The two fixed bytes.
    First,
    /// The 2 or 8 extended length bytes.
    Extended,
    /// The 4-byte client mask.
    Mask,
    /// The payload.
    Payload,
}

pub struct FrameReader<R, B: MessageBody = Plain> {
    io: R,
    buffer: BytesMut,
    assembler: Assembler<B>,
    allow_rsv1: bool,
    state: State,
    first: Option<First>,
    mask: [u8; 4],
    length: usize,
}

impl<R: AsyncRead + Unpin> FrameReader<R, Plain> {
    /// A reader over `io`, with no extension negotiated and an empty assembler.
    pub fn new(io: R) -> Self {
        Self::with_body(io, Plain::new())
    }
}

impl<R: AsyncRead + Unpin, B: MessageBody> FrameReader<R, B> {
    /// A reader that collects messages in `body`. RSV1 is accepted exactly when the
    /// body decodes an extension ([`MessageBody::allows_rsv1`]).
    pub fn with_body(io: R, body: B) -> Self {
        Self::with_limits(io, body, FrameLimits::default())
    }

    pub(crate) fn with_limits(io: R, body: B, limits: FrameLimits) -> Self {
        let assembler = Assembler::with_limits(body, limits);
        let allow_rsv1 = assembler.body().allows_rsv1();
        Self {
            io,
            buffer: BytesMut::with_capacity(READ_CHUNK),
            assembler,
            allow_rsv1,
            state: State::First,
            first: None,
            mask: [0; 4],
            length: 0,
        }
    }

    /// The assembler this reader checks lengths against. The driver feeds every
    /// frame to it, so its message-in-flight accounting is the reader's.
    pub fn assembler_mut(&mut self) -> &mut Assembler<B> {
        &mut self.assembler
    }

    /// Bytes read and not yet parsed.
    pub(crate) fn buffered_bytes(&self) -> usize {
        self.buffer.len()
    }

    /// At the peer's end: whether a whole frame waits in the buffer, judging a
    /// frame that can never complete by the rules an arriving one meets. A
    /// partial header is no frame, and nothing can complete it; a refused one
    /// keeps its own error and close code instead of a bare end.
    ///
    /// A whole frame is left unjudged: the parser judges it as it reads, and
    /// judging it here too would count its fragment twice (`receiver.js:504`).
    pub(crate) fn front_frame(&mut self) -> Result<Front, FrameError> {
        match self.state {
            State::First => {
                let Some(short) = self.buffer.get(..2) else {
                    // Fewer bytes than a header: no frame, and no tail to come.
                    return Ok(Front::Partial);
                };
                let first = parse_first([short[0], short[1]], self.allow_rsv1)?;
                // `ws` refuses a frame from its first two bytes and before its
                // extended length arrives (`receiver.js:262-280`).
                self.assembler
                    .check(first.opcode, first.fin, first.rsv1)
                    .map_err(FrameError::from)?;
                let Some((length, whole)) = lengths(&self.buffer, first)? else {
                    return Ok(Front::Partial);
                };
                if whole <= self.buffer.len() {
                    return Ok(Front::Whole);
                }
                self.judge(first, length)?;
                Ok(Front::Partial)
            }
            // A cancelled parse already took the header through `check`, and,
            // once the extended length was in, through `accept`.
            State::Extended => {
                let Some(first) = self.first else {
                    return Ok(Front::Partial);
                };
                let extended = extended_len(first.short);
                let Some(header) = self.buffer.get(..extended) else {
                    return Ok(Front::Partial);
                };
                let length = payload_length(first.short, header)?;
                if self.buffer.len() >= extended.saturating_add(4).saturating_add(length) {
                    return Ok(Front::Whole);
                }
                self.judge(first, length)?;
                Ok(Front::Partial)
            }
            State::Mask => {
                if self.buffer.len() >= self.length.saturating_add(4) {
                    Ok(Front::Whole)
                } else {
                    Ok(Front::Partial)
                }
            }
            State::Payload => {
                if self.buffer.len() >= self.length {
                    Ok(Front::Whole)
                } else {
                    Ok(Front::Partial)
                }
            }
        }
    }

    /// Takes the front frame's header through the rules that depend on the
    /// message in flight and on its size, exactly as the parser does once the
    /// header is in. Only a frame that can never complete is judged this way,
    /// so nothing is counted that the parser would count again.
    fn judge(&mut self, first: First, length: usize) -> Result<(), FrameError> {
        self.first = Some(first);
        self.length = length;
        self.admit()
    }

    /// Fills the buffer without parsing anything, so a reader that is not
    /// allowed to read frames still notices the peer's end: true while the
    /// connection is up, false at a clean end. It stops at `limit` buffered
    /// bytes and answers true there; the caller waits instead of reading on.
    /// Each read is limited to the room left, so the buffer never passes it.
    pub(crate) fn poll_watch(
        &mut self,
        cx: &mut Context<'_>,
        limit: usize,
    ) -> Poll<Result<bool, FrameError>> {
        while let Some(room) = limit
            .checked_sub(self.buffer.len())
            .filter(|room| *room > 0)
        {
            match self.poll_more_upto(cx, room) {
                Poll::Pending => return Poll::Pending,
                Poll::Ready(Ok(true)) => {}
                Poll::Ready(Ok(false)) => return Poll::Ready(Ok(false)),
                Poll::Ready(Err(error)) => return Poll::Ready(Err(error)),
            }
        }
        Poll::Ready(Ok(true))
    }

    /// Appends one read's bytes. False when the peer closed cleanly.
    fn poll_more(&mut self, cx: &mut Context<'_>) -> Poll<Result<bool, FrameError>> {
        self.poll_more_upto(cx, READ_CHUNK)
    }

    /// Appends one read's bytes, at most `room`, which must not be zero: an
    /// empty read buffer reads as the peer's end.
    fn poll_more_upto(
        &mut self,
        cx: &mut Context<'_>,
        room: usize,
    ) -> Poll<Result<bool, FrameError>> {
        let room = room.min(READ_CHUNK);
        debug_assert!(room > 0, "a read needs room");
        let mut chunk = [0u8; READ_CHUNK];
        let mut buf = ReadBuf::new(&mut chunk[..room]);
        match Pin::new(&mut self.io).poll_read(cx, &mut buf) {
            Poll::Pending => Poll::Pending,
            Poll::Ready(Err(error)) => Poll::Ready(Err(FrameError::Io(error))),
            Poll::Ready(Ok(())) => {
                let filled = buf.filled();
                if filled.is_empty() {
                    return Poll::Ready(Ok(false));
                }
                self.buffer.extend_from_slice(filled);
                Poll::Ready(Ok(true))
            }
        }
    }

    /// Fills until at least `needed` bytes wait in the buffer. False only when
    /// the peer closed with nothing left; a close in the middle of a frame is an
    /// I/O error.
    fn poll_fill(&mut self, cx: &mut Context<'_>, needed: usize) -> Poll<Result<bool, FrameError>> {
        while self.buffer.len() < needed {
            match self.poll_more(cx) {
                Poll::Pending => return Poll::Pending,
                Poll::Ready(Err(error)) => return Poll::Ready(Err(error)),
                Poll::Ready(Ok(true)) => {}
                Poll::Ready(Ok(false)) if self.buffer.is_empty() => {
                    return Poll::Ready(Ok(false));
                }
                Poll::Ready(Ok(false)) => return Poll::Ready(Err(FrameError::incomplete())),
            }
        }
        Poll::Ready(Ok(true))
    }

    /// The header is complete: account it in the message in flight and check its
    /// total before the payload is read.
    fn admit(&mut self) -> Result<(), FrameError> {
        let Some(first) = self.first else {
            return Ok(());
        };
        self.assembler
            .accept(first.opcode, first.fin, self.length)
            .map_err(FrameError::from)
    }
}

impl<R: AsyncRead + Unpin, B: MessageBody + Unpin> Stream for FrameReader<R, B> {
    type Item = Result<Frame, FrameError>;

    fn poll_next(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Option<Self::Item>> {
        let this = self.get_mut();
        loop {
            match this.state {
                State::First => {
                    if this.buffer.is_empty() {
                        match this.poll_more(cx) {
                            Poll::Pending => return Poll::Pending,
                            Poll::Ready(Ok(true)) => {}
                            Poll::Ready(Ok(false)) => return Poll::Ready(None),
                            Poll::Ready(Err(error)) => return Poll::Ready(Some(Err(error))),
                        }
                    }
                    match this.poll_fill(cx, 2) {
                        Poll::Pending => return Poll::Pending,
                        Poll::Ready(Ok(true)) => {}
                        // The clean end was handled above.
                        Poll::Ready(Ok(false)) => return Poll::Ready(None),
                        Poll::Ready(Err(error)) => return Poll::Ready(Some(Err(error))),
                    }
                    let bytes = [this.buffer[0], this.buffer[1]];
                    this.buffer.advance(2);

                    let first = match parse_first(bytes, this.allow_rsv1) {
                        Ok(first) => first,
                        Err(error) => return Poll::Ready(Some(Err(error))),
                    };
                    if let Err(code) = this.assembler.check(first.opcode, first.fin, first.rsv1) {
                        let error = FrameError::from(code);
                        return Poll::Ready(Some(Err(error)));
                    }
                    this.first = Some(first);
                    if extended_len(first.short) == 0 {
                        this.length = usize::from(first.short);
                        if let Err(error) = this.admit() {
                            return Poll::Ready(Some(Err(error)));
                        }
                        this.state = State::Mask;
                    } else {
                        this.state = State::Extended;
                    }
                }
                State::Extended => {
                    let Some(first) = this.first else {
                        return Poll::Ready(Some(Err(FrameError::protocol(
                            "missing frame header",
                        ))));
                    };
                    let extended = extended_len(first.short);
                    match this.poll_fill(cx, extended) {
                        Poll::Pending => return Poll::Pending,
                        Poll::Ready(Ok(false)) => return Poll::Ready(None),
                        Poll::Ready(Err(error)) => return Poll::Ready(Some(Err(error))),
                        Poll::Ready(Ok(true)) => {}
                    }
                    let length = match payload_length(first.short, &this.buffer[..extended]) {
                        Ok(length) => length,
                        Err(error) => return Poll::Ready(Some(Err(error))),
                    };
                    this.buffer.advance(extended);
                    this.length = length;
                    if let Err(error) = this.admit() {
                        return Poll::Ready(Some(Err(error)));
                    }
                    this.state = State::Mask;
                }
                State::Mask => {
                    match this.poll_fill(cx, 4) {
                        Poll::Pending => return Poll::Pending,
                        Poll::Ready(Ok(false)) => return Poll::Ready(None),
                        Poll::Ready(Err(error)) => return Poll::Ready(Some(Err(error))),
                        Poll::Ready(Ok(true)) => {}
                    }
                    this.mask.copy_from_slice(&this.buffer[..4]);
                    this.buffer.advance(4);
                    this.state = State::Payload;
                }
                State::Payload => {
                    match this.poll_fill(cx, this.length) {
                        Poll::Pending => return Poll::Pending,
                        Poll::Ready(Ok(false)) => return Poll::Ready(None),
                        Poll::Ready(Err(error)) => return Poll::Ready(Some(Err(error))),
                        Poll::Ready(Ok(true)) => {}
                    }
                    let Some(first) = this.first else {
                        return Poll::Ready(Some(Err(FrameError::protocol(
                            "missing frame header",
                        ))));
                    };
                    // Split, unmask in place, freeze: the frame's bytes are the
                    // reader's own, never a second copy of them.
                    let mut payload = this.buffer.split_to(this.length);
                    unmask(&mut payload, this.mask);
                    this.state = State::First;
                    this.first = None;
                    let frame = Frame {
                        fin: first.fin,
                        rsv1: first.rsv1,
                        opcode: first.opcode,
                        payload: payload.freeze(),
                    };
                    return Poll::Ready(Some(Ok(frame)));
                }
            }
        }
    }
}

/// RFC 6455 §5.3: the client's mask, applied to its payload.
fn unmask(payload: &mut [u8], mask: [u8; 4]) {
    if mask == [0; 4] {
        return;
    }
    for (index, byte) in payload.iter_mut().enumerate() {
        *byte ^= mask[index & 3];
    }
}

/// The payload length a parsed header declares and the length of its whole
/// frame - both header bytes, any extended length, the mask and the payload -
/// or `None` while the extended length is still incomplete. An extended length
/// the rules refuse keeps its own error.
fn lengths(bytes: &[u8], first: First) -> Result<Option<(usize, usize)>, FrameError> {
    let extended = extended_len(first.short);
    let length = if extended == 0 {
        usize::from(first.short)
    } else {
        let Some(header) = bytes.get(2..2 + extended) else {
            return Ok(None);
        };
        payload_length(first.short, header)?
    };
    let whole = 2usize
        .saturating_add(extended)
        .saturating_add(4)
        .saturating_add(length);
    Ok(Some((length, whole)))
}
