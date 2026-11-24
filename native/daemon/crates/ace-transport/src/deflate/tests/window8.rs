// SPDX-License-Identifier: Apache-2.0
//! RFC 1951's raw-deflate decoder, test-only, whose history is the 256 bytes an
//! 8-bit window may reference (RFC 7692 §7.2.1). It fails with [`Error::DistanceTooFar`]
//! on any back-reference past that window, which is what proves
//! `deflate_window(Some(8))`'s output is safe for a client that asked for 8.
//! Written from RFC 1951 §3.2 (the bitstream, the two trees and the length and
//! distance tables); no zlib is involved, so a window bug in `flate2` cannot hide.

/// The bytes a distance may reach back: one 8-bit window.
pub const WINDOW: usize = 256;

#[derive(Debug, PartialEq, Eq)]
pub enum Error {
    /// A back-reference further back than the 256-byte window.
    DistanceTooFar { distance: usize },
    /// The stream's bits or codes are not a valid deflate stream.
    Corrupt,
    /// The stream ended in the middle of a block.
    Truncated,
}

/// The length codes 257..=285: base lengths and the bits that extend them.
const LENGTH_BASE: [u16; 29] = [
    3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131,
    163, 195, 227, 258,
];
const LENGTH_EXTRA: [u8; 29] = [
    0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0,
];
const DISTANCE_BASE: [u16; 30] = [
    1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537,
    2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577,
];
const DISTANCE_EXTRA: [u8; 30] = [
    0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13,
    13,
];

/// A canonical Huffman tree, decoded by length as RFC 1951 §3.2.2 describes.
struct Huffman {
    /// `count[len]` codes have that length.
    count: [u16; 16],
    /// The symbols in code order, one per code length.
    symbols: Vec<u16>,
}

impl Huffman {
    /// Builds the tree from the record's code lengths. `None` when the lengths
    /// do not form a complete tree (the stream invents codes it cannot decode).
    fn new(lengths: &[u8]) -> Option<Self> {
        let mut count = [0u16; 16];
        for &length in lengths {
            if length > 15 {
                return None;
            }
            if length > 0 {
                count[usize::from(length)] += 1;
            }
        }
        let mut symbols = vec![0u16; usize::from(count.iter().sum::<u16>())];
        let mut at = [0usize; 16];
        let mut start = 0usize;
        for length in 1..=15 {
            at[length] = start;
            start += usize::from(count[length]);
        }
        for (symbol, &length) in lengths.iter().enumerate() {
            if length > 0 {
                let slot = at[usize::from(length)];
                symbols[slot] = symbol as u16;
                at[usize::from(length)] += 1;
            }
        }
        Some(Self { count, symbols })
    }

    /// One symbol, read bit by bit until a code matches.
    fn symbol(&self, bits: &mut Bits<'_>) -> Result<u16, Error> {
        // RFC 1951 §3.2.2's canonical decode, as zlib's reference decoder walks it.
        let mut code = 0u16;
        let mut first = 0u16;
        let mut index = 0usize;
        for length in 1..=15u8 {
            code |= bits.take(1)?;
            let count = self.count[usize::from(length)];
            if code.wrapping_sub(first) < count {
                return self
                    .symbols
                    .get(index + usize::from(code - first))
                    .copied()
                    .ok_or(Error::Corrupt);
            }
            index += usize::from(count);
            first = (first + count) << 1;
            code <<= 1;
        }
        Err(Error::Corrupt)
    }
}

/// The bitstream: RFC 1951 packs bytes least-significant bit first.
struct Bits<'a> {
    bytes: &'a [u8],
    at: usize,
    bit: u8,
}

impl<'a> Bits<'a> {
    fn new(bytes: &'a [u8]) -> Self {
        Self {
            bytes,
            at: 0,
            bit: 0,
        }
    }

    /// The bits the stream still holds.
    fn remaining(&self) -> usize {
        (self.bytes.len() - self.at) * 8 - usize::from(self.bit)
    }

    fn take(&mut self, count: u8) -> Result<u16, Error> {
        let mut value = 0u16;
        for index in 0..count {
            let byte = *self.bytes.get(self.at).ok_or(Error::Truncated)?;
            value |= u16::from((byte >> self.bit) & 1) << index;
            self.bit += 1;
            if self.bit == 8 {
                self.bit = 0;
                self.at += 1;
            }
        }
        Ok(value)
    }

    /// Discards whole bytes up to the next byte boundary, as a stored block does.
    fn align(&mut self) {
        if self.bit != 0 {
            self.bit = 0;
            self.at += 1;
        }
    }
}

/// The decoded message, or why the stream is not one this window can hold.
///
/// `payload` is an RFC 7692 message's bytes, whose trailing sync-flush block the
/// sender removed; the four bytes are restored here exactly as a receiver does
/// (RFC 7692 §7.2.2), so the stream ends on a block boundary.
pub fn decode_message(payload: &[u8]) -> Result<Vec<u8>, Error> {
    let mut stream = payload.to_vec();
    stream.extend_from_slice(&[0x00, 0x00, 0xff, 0xff]);
    let mut bits = Bits::new(&stream);
    let mut output = Vec::new();
    loop {
        // A sync flush never sets a final block, so an exhausted stream between
        // blocks is the end of the message.
        if bits.remaining() < 3 {
            return Ok(output);
        }
        let last = bits.take(1)? == 1;
        match bits.take(2)? {
            0 => stored(&mut bits, &mut output)?,
            1 => fixed(&mut bits, &mut output)?,
            2 => dynamic(&mut bits, &mut output)?,
            _ => return Err(Error::Corrupt),
        }
        if last {
            return Ok(output);
        }
    }
}

/// A stored block: its length, then its bytes, both byte-aligned.
fn stored(bits: &mut Bits<'_>, output: &mut Vec<u8>) -> Result<(), Error> {
    bits.align();
    let mut header = [0u8; 4];
    for byte in &mut header {
        *byte = bits.take(8)? as u8;
    }
    let length = usize::from(u16::from_le_bytes([header[0], header[1]]));
    let complement = u16::from_le_bytes([header[2], header[3]]);
    if complement != !(length as u16) {
        return Err(Error::Corrupt);
    }
    for _ in 0..length {
        output.push(bits.take(8)? as u8);
    }
    Ok(())
}

fn fixed(bits: &mut Bits<'_>, output: &mut Vec<u8>) -> Result<(), Error> {
    let mut lengths = [0u8; 288];
    for (symbol, length) in lengths.iter_mut().enumerate() {
        *length = match symbol {
            0..=143 => 8,
            144..=255 => 9,
            256..=279 => 7,
            _ => 8,
        };
    }
    let literals = Huffman::new(&lengths).ok_or(Error::Corrupt)?;
    // Fixed distance codes are five bits, symbol = the code as read.
    let distances = Huffman::new(&[5u8; 32]).ok_or(Error::Corrupt)?;
    inflate(&mut literal_symbols(&literals, &distances), bits, output)
}

fn dynamic(bits: &mut Bits<'_>, output: &mut Vec<u8>) -> Result<(), Error> {
    let literals = bits.take(5)? as usize + 257;
    let distances = bits.take(5)? as usize + 1;
    let code_lengths = bits.take(4)? as usize + 4;
    if literals > 286 || distances > 30 {
        return Err(Error::Corrupt);
    }
    const ORDER: [usize; 19] = [
        16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15,
    ];
    let mut lengths = [0u8; 19];
    for &slot in ORDER.iter().take(code_lengths) {
        lengths[slot] = bits.take(3)? as u8;
    }
    let tree = Huffman::new(&lengths).ok_or(Error::Corrupt)?;
    let mut decoded = vec![0u8; literals + distances];
    let mut at = 0;
    while at < decoded.len() {
        let symbol = tree.symbol(bits)?;
        match symbol {
            0..=15 => {
                decoded[at] = symbol as u8;
                at += 1;
            }
            16 => {
                let previous = *decoded
                    .get(at.checked_sub(1).ok_or(Error::Corrupt)?)
                    .ok_or(Error::Corrupt)?;
                let repeat = bits.take(2)? as usize + 3;
                fill(&mut decoded, &mut at, previous, repeat)?;
            }
            17 => {
                let repeat = bits.take(3)? as usize + 3;
                fill(&mut decoded, &mut at, 0, repeat)?;
            }
            18 => {
                let repeat = bits.take(7)? as usize + 11;
                fill(&mut decoded, &mut at, 0, repeat)?;
            }
            _ => return Err(Error::Corrupt),
        }
    }
    let literal_tree = Huffman::new(&decoded[..literals]).ok_or(Error::Corrupt)?;
    let distance_tree = Huffman::new(&decoded[literals..]).ok_or(Error::Corrupt)?;
    inflate(
        &mut literal_symbols(&literal_tree, &distance_tree),
        bits,
        output,
    )
}

fn fill(decoded: &mut [u8], at: &mut usize, value: u8, repeat: usize) -> Result<(), Error> {
    for _ in 0..repeat {
        if *at >= decoded.len() {
            return Err(Error::Corrupt);
        }
        decoded[*at] = value;
        *at += 1;
    }
    Ok(())
}

/// The two trees one block decodes with, as `inflate` reads them.
fn literal_symbols<'a>(literals: &'a Huffman, distances: &'a Huffman) -> Trees<'a> {
    Trees {
        literals,
        distances,
    }
}

struct Trees<'a> {
    literals: &'a Huffman,
    distances: &'a Huffman,
}

/// Literals and length/distance pairs until the end-of-block symbol.
fn inflate(trees: &mut Trees<'_>, bits: &mut Bits<'_>, output: &mut Vec<u8>) -> Result<(), Error> {
    loop {
        let symbol = trees.literals.symbol(bits)?;
        match symbol {
            0..=255 => output.push(symbol as u8),
            256 => return Ok(()),
            257..=285 => {
                let slot = usize::from(symbol - 257);
                let length =
                    usize::from(LENGTH_BASE[slot]) + bits.take(LENGTH_EXTRA[slot])? as usize;
                let code = trees.distances.symbol(bits)? as usize;
                if code >= DISTANCE_BASE.len() {
                    return Err(Error::Corrupt);
                }
                let distance =
                    usize::from(DISTANCE_BASE[code]) + bits.take(DISTANCE_EXTRA[code])? as usize;
                if distance > WINDOW {
                    return Err(Error::DistanceTooFar { distance });
                }
                if distance > output.len() {
                    return Err(Error::Corrupt);
                }
                let start = output.len() - distance;
                for offset in 0..length {
                    let byte = output[start + offset];
                    output.push(byte);
                }
            }
            _ => return Err(Error::Corrupt),
        }
    }
}
