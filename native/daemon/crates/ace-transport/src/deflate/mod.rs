// SPDX-License-Identifier: Apache-2.0
//! Per-message deflate on the remote listeners (RFC 7692): `negotiate` reads the
//! offer and writes the answer, `codec` moves a message's bytes through raw
//! deflate, and [`Body`] is what the frame assembler collects a message in.
//! Nothing here decides to compress: the shell says so per send, and Rust adds
//! `ws`'s threshold (`sender.js:382`). Loopback sockets never negotiate, so they
//! never compress.

use crate::frame::MAX_MESSAGE_BYTES;
use crate::frame::assemble::{MessageBody, Plain};

pub mod codec;
pub mod negotiate;

#[cfg(test)]
mod tests;

pub use codec::{Deflater, INFLATE_WINDOW, Inflating, THRESHOLD, deflate_window};
pub use negotiate::{Deflate, Malformed, negotiate};

/// A message's bytes, plain or inflated. A socket that negotiated the extension
/// still receives messages its peer chose not to compress, so the message's own
/// first frame decides which way its bytes are read.
pub struct Body {
    plain: Plain,
    inflate: Option<Inflating>,
    compressed: bool,
}

impl Body {
    /// No extension: RSV1 never arrives, and every message is its bytes.
    pub fn plain() -> Self {
        Self::configured(None, MAX_MESSAGE_BYTES)
    }

    /// `permessage-deflate` negotiated: a message with RSV1 set is inflated.
    pub fn compressed() -> Self {
        Self::configured(Some(Inflating::new()), MAX_MESSAGE_BYTES)
    }

    pub(crate) fn with_payload_limit(deflate: Option<&Deflate>, max_payload: usize) -> Self {
        let inflate = deflate.map(|_| Inflating::with_payload_limit(max_payload));
        Self::configured(inflate, max_payload)
    }

    fn configured(inflate: Option<Inflating>, max_payload: usize) -> Self {
        Self {
            plain: Plain::with_payload_limit(max_payload),
            inflate,
            compressed: false,
        }
    }
}

impl MessageBody for Body {
    fn begin(&mut self, compressed: bool) {
        self.compressed = compressed && self.inflate.is_some();
    }

    fn feed(&mut self, fragment: &[u8], fin: bool) -> Result<usize, crate::frame::CloseCode> {
        match (&mut self.inflate, self.compressed) {
            (Some(inflating), true) => inflating.feed(fragment, fin),
            _ => self.plain.feed(fragment, fin),
        }
    }

    fn finish(&mut self) -> Vec<u8> {
        match (&mut self.inflate, self.compressed) {
            (Some(inflating), true) => inflating.finish(),
            _ => self.plain.finish(),
        }
    }

    fn reset(&mut self) {
        self.plain.reset();
        if let Some(inflating) = &mut self.inflate {
            inflating.reset();
        }
        self.compressed = false;
    }

    fn allows_rsv1(&self) -> bool {
        self.inflate.is_some()
    }
}

/// Whether a frame's payload is worth deflating: data, asked for, and at least
/// [`THRESHOLD`] bytes (`sender.js:372`–`:385`). Control frames never compress.
pub fn may_compress(opcode: crate::frame::Opcode, length: usize, ask: bool) -> bool {
    ask && opcode.is_data() && length >= THRESHOLD
}
