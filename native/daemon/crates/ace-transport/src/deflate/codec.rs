// SPDX-License-Identifier: Apache-2.0
//! RFC 7692 §7's DEFLATE half over `flate2` with the zlib-rs backend: raw
//! deflate at level 6, `Z_SYNC_FLUSH`, the four-byte trailer stripped on send and
//! restored on receive, and a fresh context per message in both directions
//! (no context takeover was negotiated, always). Inflating counts each chunk as
//! zlib produces it, so the post-inflate cap fails the message inside the loop.

use flate2::{Compress, Compression, Decompress, FlushCompress, FlushDecompress, Status};

use crate::frame::assemble::MessageBody;
use crate::frame::{CloseCode, MAX_MESSAGE_BYTES};

/// The inflater's window: a 15-bit window reads every stream a smaller one can
/// produce, so it never refuses a client whose window is smaller (behaviour.md
/// §2's recorded difference).
pub const INFLATE_WINDOW: u8 = 15;

/// `ws`'s `threshold` with no context takeover (`sender.js:382`): a message under
/// this many bytes goes as it is.
pub const THRESHOLD: usize = 1024;

/// RFC 7692 §7.2.1: the empty stored block a sync flush ends with, which the
/// sender removes and the receiver restores.
const TRAILER: [u8; 4] = [0x00, 0x00, 0xff, 0xff];

/// What `ws` compresses with: `zlibDeflateOptions { level: 6, memLevel: 8 }`.
const LEVEL: Compression = Compression::new(6);

/// One pass's output buffer: 16 KiB, so a compressed message inflates a chunk at
/// a time and the cap stops it early rather than after the whole message.
pub(crate) const CHUNK: usize = 16 * 1024;

/// The window a deflater is built with: never outside 9..=15, whose constructors
/// panic (flate2-1.1.11/src/mem.rs:218-228). `None` is 15, and 8 is built as 9:
/// zlib-rs at level 6 caps a 9-bit window's match distance at 250, inside the 256
/// bytes an 8-bit window may rely on, while the answer still echoes `=8`.
pub fn deflate_window(server_max_window_bits: Option<u8>) -> u8 {
    match server_max_window_bits {
        None => 15,
        Some(8) => 9,
        Some(bits) if (9..=15).contains(&bits) => bits,
        // Negotiation never lets another value through (`negotiate.rs`).
        Some(_) => 15,
    }
}

/// One outbound context, reset after every message: no context is ever taken over.
pub struct Deflater {
    compress: Compress,
}

impl Deflater {
    pub fn new(window: u8) -> Self {
        Self {
            compress: Compress::new_with_window_bits(LEVEL, false, window),
        }
    }

    /// The message's compressed bytes with the RFC 7692 trailer removed, or `None`
    /// when the deflater failed (memory exhaustion): the caller then sends the
    /// message as it is rather than as a broken frame.
    pub fn deflate(&mut self, data: &[u8]) -> Option<Vec<u8>> {
        let mut output = Vec::with_capacity(data.len() / 2 + 16);
        let mut chunk = [0u8; CHUNK];
        let mut consumed = 0;
        loop {
            let before_in = self.compress.total_in();
            let before_out = self.compress.total_out();
            let status = self
                .compress
                .compress(&data[consumed..], &mut chunk, FlushCompress::Sync)
                .ok()?;
            let produced = (self.compress.total_out() - before_out) as usize;
            consumed += (self.compress.total_in() - before_in) as usize;
            output.extend_from_slice(&chunk[..produced]);
            match status {
                // More input to feed, or the flush still has output buffered.
                Status::Ok if consumed < data.len() || produced == chunk.len() => {}
                _ => break,
            }
        }
        // The sync flush ends with the empty stored block; the payload excludes it.
        if output.ends_with(&TRAILER) {
            output.truncate(output.len() - TRAILER.len());
        }
        self.compress.reset();
        Some(output)
    }
}

/// One inbound message, inflated as each fragment arrives. Both contexts reset
/// after every message, so no state crosses one.
pub struct Inflating {
    decompress: Decompress,
    buffer: Vec<u8>,
    chunk: Vec<u8>,
}

impl Inflating {
    pub fn new() -> Self {
        Self {
            decompress: Decompress::new_with_window_bits(false, INFLATE_WINDOW),
            buffer: Vec::new(),
            chunk: vec![0; CHUNK],
        }
    }

    /// The message bytes reserved so far, for the cap test.
    #[cfg(test)]
    pub(crate) fn capacity(&self) -> usize {
        self.buffer.capacity()
    }

    /// Feeds one input to zlib, appending each output chunk it produces and
    /// refusing the byte past the message limit inside this loop.
    fn pump(&mut self, input: &[u8], flush: FlushDecompress) -> Result<(), CloseCode> {
        let mut consumed = 0;
        loop {
            let before_in = self.decompress.total_in();
            let before_out = self.decompress.total_out();
            let status =
                match self
                    .decompress
                    .decompress(&input[consumed..], &mut self.chunk, flush)
                {
                    Ok(status) => status,
                    Err(_) => return Err(CloseCode::BadDeflate),
                };
            let produced = (self.decompress.total_out() - before_out) as usize;
            consumed += (self.decompress.total_in() - before_in) as usize;
            // The chunk and the message buffer are separate fields, so the
            // borrows do not overlap.
            let chunk = &self.chunk[..produced];
            append(&mut self.buffer, chunk)?;
            match status {
                // The rest of the input, or more output zlib still holds.
                Status::Ok if consumed < input.len() || produced == self.chunk.len() => {}
                _ => break,
            }
        }
        Ok(())
    }
}

impl Default for Inflating {
    fn default() -> Self {
        Self::new()
    }
}

/// Appends one produced chunk, reserving exactly its bytes: a doubling
/// `extend_from_slice` could reserve past the cap on an uneven chunk, and the
/// brief's bound is the cap plus this one staging chunk.
fn append(buffer: &mut Vec<u8>, bytes: &[u8]) -> Result<(), CloseCode> {
    if buffer.len() + bytes.len() > MAX_MESSAGE_BYTES {
        return Err(CloseCode::TooBig);
    }
    if buffer.capacity() < buffer.len() + bytes.len()
        && buffer.try_reserve_exact(bytes.len()).is_err()
    {
        // The allocator refused while the message is inside its cap: this
        // connection cannot hold it, so it ends here rather than growing.
        return Err(CloseCode::TooBig);
    }
    buffer.extend_from_slice(bytes);
    Ok(())
}

impl MessageBody for Inflating {
    fn feed(&mut self, fragment: &[u8], fin: bool) -> Result<usize, CloseCode> {
        self.pump(fragment, FlushDecompress::None)?;
        // RFC 7692 §7.2.2: the final fragment's trailer completes the stream.
        if fin {
            self.pump(&TRAILER, FlushDecompress::Sync)?;
        }
        Ok(self.buffer.len())
    }

    fn finish(&mut self) -> Vec<u8> {
        std::mem::take(&mut self.buffer)
    }

    fn reset(&mut self) {
        self.buffer.clear();
        self.decompress.reset(false);
    }

    fn allows_rsv1(&self) -> bool {
        true
    }
}
