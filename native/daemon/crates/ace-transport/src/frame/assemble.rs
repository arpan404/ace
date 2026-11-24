// SPDX-License-Identifier: Apache-2.0
//! A message's fragments, joined as they arrive. `Assembler` owns the rules that
//! depend on what is already in flight (which opcode may start, which may
//! continue, the 1 MiB wire total); `MessageBody` owns the bytes, so T1b.3b's
//! inflating body can count the output during inflation instead of after.

use super::{CloseCode, Frame, MAX_MESSAGE_BYTES, Opcode};

/// `ws`'s `maxFragments` default (`websocket-server.js:73`): one message may not
/// split into more data frames than this, empty fragments included.
pub const MAX_FRAGMENTS: usize = 16 * 1024;

/// What a message's bytes are collected in. One fragment is fed at a time, so a
/// body can refuse the byte that takes a message over its limit before the rest
/// of the message exists.
pub trait MessageBody: Send {
    /// One message's first data frame: whether it is compressed (RSV1 set). A body
    /// that decodes an extension switches between plain and decoding for it, since
    /// a peer may send either on a socket that negotiated.
    fn begin(&mut self, compressed: bool) {
        let _ = compressed;
    }
    /// One fragment's payload; returns the message's bytes so far, or the close
    /// code to fail with.
    fn feed(&mut self, fragment: &[u8], fin: bool) -> Result<usize, CloseCode>;
    /// The whole message, exclusively owned.
    fn finish(&mut self) -> Vec<u8>;
    fn reset(&mut self);
    /// Whether RSV1 may arrive at all: only a body that decodes an extension can.
    fn allows_rsv1(&self) -> bool {
        false
    }
}

/// The bytes themselves: appends, refusing the byte past [`MAX_MESSAGE_BYTES`]
/// with 1009. Compression's body (T1b.3b) puts inflation here.
#[derive(Debug, Default)]
pub struct Plain {
    buffer: Vec<u8>,
}

impl Plain {
    pub fn new() -> Self {
        Self::default()
    }
}

impl MessageBody for Plain {
    fn feed(&mut self, fragment: &[u8], _fin: bool) -> Result<usize, CloseCode> {
        let total = self.buffer.len().saturating_add(fragment.len());
        if total > MAX_MESSAGE_BYTES {
            return Err(CloseCode::TooBig);
        }
        self.buffer.extend_from_slice(fragment);
        Ok(self.buffer.len())
    }

    fn finish(&mut self) -> Vec<u8> {
        std::mem::take(&mut self.buffer)
    }

    fn reset(&mut self) {
        self.buffer.clear();
    }
}

/// One whole message the assembler completed.
#[derive(Debug, PartialEq, Eq)]
pub struct Message {
    pub data: Vec<u8>,
    pub binary: bool,
}

/// The frames of one connection, in order. Control frames pass straight through
/// and never disturb a fragmented message.
pub struct Assembler<B: MessageBody = Plain> {
    body: B,
    /// The data frame whose continuation the reader may accept next, if any.
    pending: Option<Opcode>,
    /// Wire payload bytes of the message in flight, exactly as `ws` counts them.
    total: usize,
    /// The data frame `push` is joining fragments into, if any.
    kind: Option<Opcode>,
    /// Data fragments seen in the message in flight, empty ones included.
    fragments: usize,
}

impl Assembler<Plain> {
    pub fn new() -> Self {
        Self::with_body(Plain::new())
    }
}

impl Default for Assembler<Plain> {
    fn default() -> Self {
        Self::new()
    }
}

impl<B: MessageBody> Assembler<B> {
    pub fn with_body(body: B) -> Self {
        Self {
            body,
            pending: None,
            total: 0,
            kind: None,
            fragments: 0,
        }
    }

    /// Whether the next frame's header still fits `ws`'s rules for the message in
    /// flight. Asked before the payload is read, so an oversized message fails
    /// from its header alone (receiver.js:432-445).
    pub fn admits(&self, opcode: Opcode, length: usize) -> bool {
        if opcode.is_control() || length == 0 {
            return true;
        }
        self.total.saturating_add(length) <= MAX_MESSAGE_BYTES
    }

    /// The rules that depend on the message already in flight
    /// (receiver.js:230-257, :281-292). The header has already refused reserved
    /// opcodes, RSV bits and control-frame shapes.
    pub fn check(&self, opcode: Opcode, fin: bool, rsv1: bool) -> Result<(), CloseCode> {
        match opcode {
            Opcode::Continuation => {
                if rsv1 || self.pending.is_none() {
                    return Err(CloseCode::Protocol);
                }
            }
            Opcode::Text | Opcode::Binary => {
                if self.pending.is_some() {
                    return Err(CloseCode::Protocol);
                }
            }
            Opcode::Close | Opcode::Ping | Opcode::Pong => {
                if !fin || rsv1 {
                    return Err(CloseCode::Protocol);
                }
            }
        }
        Ok(())
    }

    /// Accounts a frame's header in the message in flight: the reader calls this
    /// after the header and before the payload, so `admits` refuses an oversized
    /// message from the header alone. The reader is the state's only writer, so a
    /// client of the frame stream need not feed frames back to read them.
    pub fn accept(&mut self, opcode: Opcode, fin: bool, length: usize) -> Result<(), CloseCode> {
        self.check(opcode, fin, false)?;
        if !self.admits(opcode, length) {
            return Err(CloseCode::TooBig);
        }
        if opcode.is_control() {
            return Ok(());
        }
        self.fragments += 1;
        if self.fragments > MAX_FRAGMENTS {
            return Err(CloseCode::TooManyFragments);
        }
        self.total = if fin {
            0
        } else {
            self.total.saturating_add(length)
        };
        if fin {
            self.fragments = 0;
        }
        self.pending = if fin {
            None
        } else {
            Some(match opcode {
                Opcode::Continuation => self.pending.unwrap_or(Opcode::Continuation),
                kind => kind,
            })
        };
        Ok(())
    }

    /// Feeds one data frame, returning the message it completed. A control frame
    /// is not assembled and returns `None`; the caller handles it. Header state
    /// ([`Assembler::accept`]) is the reader's; this joins the bytes.
    pub fn push(&mut self, frame: Frame) -> Result<Option<Message>, CloseCode> {
        let kind = match frame.opcode {
            Opcode::Text | Opcode::Binary => {
                if self.kind.is_some() {
                    return Err(CloseCode::Protocol);
                }
                if !frame.fin {
                    self.kind = Some(frame.opcode);
                }
                // The first data frame says whether this message's bytes are an
                // extension's (T1b.3b): continuations never carry RSV1.
                self.body.begin(frame.rsv1);
                frame.opcode
            }
            Opcode::Continuation => self.kind.ok_or(CloseCode::Protocol)?,
            Opcode::Close | Opcode::Ping | Opcode::Pong => return Ok(None),
        };

        self.body.feed(&frame.payload, frame.fin)?;

        if !frame.fin {
            return Ok(None);
        }

        let data = self.body.finish();
        self.body.reset();
        self.kind = None;
        let binary = kind == Opcode::Binary;
        if !binary && std::str::from_utf8(&data).is_err() {
            return Err(CloseCode::InvalidUtf8);
        }
        Ok(Some(Message { data, binary }))
    }

    /// The body underneath, for tests and for the extension T1b.3b installs.
    pub fn body(&self) -> &B {
        &self.body
    }

    /// The body underneath, for tests and for the extension T1b.3b installs.
    pub fn body_mut(&mut self) -> &mut B {
        &mut self.body
    }
}

/// A close frame's payload: `None` for an empty frame (`ws`'s 1005), or the code
/// and reason after `ws`'s checks (receiver.js:664-697).
pub fn conclude(payload: &[u8]) -> Result<Option<(u16, Vec<u8>)>, CloseCode> {
    if payload.is_empty() {
        return Ok(None);
    }
    if payload.len() == 1 {
        return Err(CloseCode::Protocol);
    }
    let code = u16::from_be_bytes([payload[0], payload[1]]);
    if !valid_status(code) {
        return Err(CloseCode::Protocol);
    }
    let reason = &payload[2..];
    std::str::from_utf8(reason).map_err(|_| CloseCode::InvalidUtf8)?;
    Ok(Some((code, reason.to_vec())))
}

/// `ws`'s `isValidStatusCode` (validation.js:37-45).
pub fn valid_status(code: u16) -> bool {
    ((1000..=1014).contains(&code) && !matches!(code, 1004..=1006)) || (3000..=4999).contains(&code)
}
