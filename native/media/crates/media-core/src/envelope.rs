// SPDX-License-Identifier: Apache-2.0
//! ACES framing. Pieces borrow the sender's buffers; assembly reuses one bounded buffer.
use std::fmt;

pub const PREFIX_BYTES: usize = 20;
pub const PIECE_BYTES: usize = 65_518;
pub const LEGACY_PIECE_BYTES: usize = 65_536;
pub const MAX_BYTES: usize = 8 * 1024 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Error {
    Kind,
    Meta,
    Bounds,
    Magic,
    Version,
    Order,
    Empty,
}
impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "ACES {self:?}")
    }
}
impl std::error::Error for Error {}

pub fn is_stream_piece(bytes: &[u8]) -> bool {
    bytes.len() >= PREFIX_BYTES && &bytes[..4] == b"ACES"
}

/// Scatter/gather piece: concatenating these three slices produces the wire bytes.
#[derive(Debug)]
pub struct Piece<'a> {
    pub prefix: [u8; PREFIX_BYTES],
    pub meta: &'a [u8],
    pub payload: &'a [u8],
}
impl Piece<'_> {
    pub fn len(&self) -> usize {
        PREFIX_BYTES + self.meta.len() + self.payload.len()
    }
    pub fn is_empty(&self) -> bool {
        false
    }
    /// Copy only at a transport boundary that cannot send scatter/gather buffers.
    pub fn write_to(&self, out: &mut [u8]) -> Result<usize, Error> {
        let out = out.get_mut(..self.len()).ok_or(Error::Bounds)?;
        out[..PREFIX_BYTES].copy_from_slice(&self.prefix);
        let at = PREFIX_BYTES + self.meta.len();
        out[PREFIX_BYTES..at].copy_from_slice(self.meta);
        out[at..].copy_from_slice(self.payload);
        Ok(out.len())
    }
}

pub struct Pieces<'a> {
    kind: u8,
    id: u32,
    meta: &'a [u8],
    payload: &'a [u8],
    offset: usize,
    limit: usize,
    done: bool,
}
impl<'a> Pieces<'a> {
    pub fn new(kind: u8, id: u32, meta: &'a [u8], payload: &'a [u8]) -> Result<Self, Error> {
        Self::with_limit(kind, id, meta, payload, PIECE_BYTES)
    }
    /// Compatibility with pre-0147 senders and the frozen TypeScript vectors.
    pub fn legacy(kind: u8, id: u32, meta: &'a [u8], payload: &'a [u8]) -> Result<Self, Error> {
        Self::with_limit(kind, id, meta, payload, LEGACY_PIECE_BYTES)
    }
    fn with_limit(
        kind: u8,
        id: u32,
        meta: &'a [u8],
        payload: &'a [u8],
        limit: usize,
    ) -> Result<Self, Error> {
        if kind == 0 {
            return Err(Error::Kind);
        }
        if meta.len() > u16::MAX as usize {
            return Err(Error::Meta);
        }
        if payload.len() > MAX_BYTES - meta.len() {
            return Err(Error::Bounds);
        }
        Ok(Self {
            kind,
            id,
            meta,
            payload,
            offset: 0,
            limit,
            done: false,
        })
    }
}
impl<'a> Iterator for Pieces<'a> {
    type Item = Piece<'a>;
    fn next(&mut self) -> Option<Self::Item> {
        if self.done {
            return None;
        }
        let total = self.meta.len() + self.payload.len();
        let end = (self.offset + self.limit - PREFIX_BYTES).min(total);
        let mut prefix = [0; PREFIX_BYTES];
        prefix[..4].copy_from_slice(b"ACES");
        prefix[4] = 1;
        prefix[5] = self.kind;
        prefix[6..8].copy_from_slice(&(self.meta.len() as u16).to_be_bytes());
        prefix[8..12].copy_from_slice(&self.id.to_be_bytes());
        prefix[12..16].copy_from_slice(&(total as u32).to_be_bytes());
        prefix[16..20].copy_from_slice(&(self.offset as u32).to_be_bytes());
        let meta = &self.meta[self.offset.min(self.meta.len())..end.min(self.meta.len())];
        let payload = &self.payload
            [self.offset.saturating_sub(self.meta.len())..end.saturating_sub(self.meta.len())];
        self.offset = end;
        self.done = end == total;
        Some(Piece {
            prefix,
            meta,
            payload,
        })
    }
}

#[derive(Debug, PartialEq)]
pub struct Envelope<'a> {
    pub kind: u8,
    pub meta: &'a [u8],
    pub payload: &'a [u8],
}
#[derive(Default)]
pub struct Assembler {
    body: Vec<u8>,
    partial: Option<(u8, u32, usize, usize)>,
}
impl Assembler {
    pub fn new() -> Self {
        Self::default()
    }
    pub fn reset(&mut self) {
        self.partial = None;
        self.body.clear();
    }
    /// The returned view pins this assembler until consumed. Single pieces borrow input;
    /// fragmented messages borrow reusable storage (at most MAX_BYTES).
    pub fn push<'a>(&'a mut self, bytes: &'a [u8]) -> Result<Option<Envelope<'a>>, Error> {
        if !(PREFIX_BYTES..=LEGACY_PIECE_BYTES).contains(&bytes.len()) {
            return Err(Error::Bounds);
        }
        if !is_stream_piece(bytes) {
            return Err(Error::Magic);
        }
        if bytes[4] != 1 {
            return Err(Error::Version);
        }
        let kind = bytes[5];
        let meta = u16::from_be_bytes([bytes[6], bytes[7]]) as usize;
        let read =
            |at| u32::from_be_bytes([bytes[at], bytes[at + 1], bytes[at + 2], bytes[at + 3]]);
        let id = read(8);
        let total = read(12) as usize;
        let offset = read(16) as usize;
        let piece = &bytes[PREFIX_BYTES..];
        if total > MAX_BYTES || meta > total || offset > total || piece.len() > total - offset {
            return Err(Error::Bounds);
        }
        let identity = (kind, id, meta, total);
        if offset == 0 {
            self.reset();
            if piece.len() == total {
                return Ok(Some(Envelope {
                    kind,
                    meta: &piece[..meta],
                    payload: &piece[meta..],
                }));
            }
            self.partial = Some(identity);
        }
        if self.partial != Some(identity) || self.body.len() != offset {
            self.reset();
            return Err(Error::Order);
        }
        if piece.is_empty() {
            return Err(Error::Empty);
        }
        // Reserve the declared size once, never a geometric capacity above the bound.
        if self.body.capacity() < total {
            self.body.reserve_exact(total - self.body.len());
        }
        self.body.extend_from_slice(piece);
        if self.body.len() < total {
            return Ok(None);
        }
        self.partial = None;
        Ok(Some(Envelope {
            kind,
            meta: &self.body[..meta],
            payload: &self.body[meta..],
        }))
    }
}
