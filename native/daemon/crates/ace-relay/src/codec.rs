// SPDX-License-Identifier: Apache-2.0
//! The relayed channel's wire codec (`apps/relay/src/channel.ts`, `@ace/secure-channel`): one
//! logical message split into encrypted fragments, the kinds a peer reads (JSON, binary, deflated
//! JSON), last-fragment marking, the 16 MiB message limit, the per-direction rekey every 2^20
//! frames, deflated JSON above 1 KiB, and credit flow control (`flow.rs`). The socket is the
//! shell's; this is what it reads and writes.

use std::io::{Read, Write};

use zeroize::Zeroizing;

use crate::cipher::MAX_MESSAGE;
use crate::error::RelayError;
use crate::noise::SessionKeys;

pub mod flow;

pub use flow::{CREDIT_FLAG, FLOW_WINDOW, FlowCredit, credit_fragment, fragment_cost, read_credit};

/// The most bytes one binary message carries.
pub const BINARY_MESSAGE_LIMIT: usize = 64 * 1024 + 16;
/// The most bytes any logical message carries.
pub const LOGICAL_MESSAGE_LIMIT: usize = 16 * 1024 * 1024;
/// Frames one direction seals before it rekeys, as `REKEY_INTERVAL`.
pub const REKEY_INTERVAL: u64 = 1 << 20;
/// Decrypted fragments a non-flow-controlled reader queues before it stops reading the socket.
/// The shell applies it; the codec's own queue never holds more than one message's fragments.
pub const PLAIN_HIGH_WATER: usize = 256 * 1024;
/// Smaller JSON messages gain too little to be worth a deflate.
pub const DEFLATE_THRESHOLD: usize = 1024;
/// The largest chunk one fragment carries: `MAX_MESSAGE - 17`, the kind byte and the 16-byte tag.
pub const CHUNK: usize = MAX_MESSAGE - 17;
/// A non-last fragment's plaintext is exactly this long (`MAX_MESSAGE - 16`).
const FULL_PLAIN: usize = MAX_MESSAGE - 16;

/// A logical message's kind, from a fragment's flag's high bits.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    Json = 0,
    Binary = 2,
    Deflated = 4,
}

impl Kind {
    fn flag(self) -> u8 {
        self as u8
    }

    fn of_flag(flag: u8) -> Option<Self> {
        match flag {
            0 => Some(Self::Json),
            2 => Some(Self::Binary),
            4 => Some(Self::Deflated),
            _ => None,
        }
    }
}

/// One whole message, as a reader's handler takes it: JSON text (inflated and UTF-8 checked) or
/// binary bytes.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Message {
    Text(String),
    Binary(Vec<u8>),
}

/// Split one logical message into the plain fragments a channel seals, each `flag || chunk`.
pub fn fragments(kind: Kind, payload: &[u8]) -> Result<Vec<Vec<u8>>, RelayError> {
    let limit = match kind {
        Kind::Binary => BINARY_MESSAGE_LIMIT,
        Kind::Json | Kind::Deflated => LOGICAL_MESSAGE_LIMIT,
    };
    if payload.is_empty() {
        return Err(RelayError::Protocol("Empty message"));
    }
    if payload.len() > limit {
        return Err(RelayError::Protocol(match kind {
            Kind::Binary => "Binary message too large",
            Kind::Json | Kind::Deflated => "Logical message or send queue too large",
        }));
    }
    let mut frames = Vec::with_capacity(payload.len().div_ceil(CHUNK));
    let mut offset = 0;
    while offset < payload.len() {
        let end = (offset + CHUNK).min(payload.len());
        let last = end == payload.len();
        let mut plain = Vec::with_capacity(end - offset + 1);
        plain.push(kind.flag() + u8::from(last));
        plain.extend_from_slice(&payload[offset..end]);
        frames.push(plain);
        offset = end;
    }
    Ok(frames)
}

/// The message one side is reading: its kind and the fragments taken so far.
#[derive(Debug, Default)]
pub struct Assembler {
    kind: Option<Kind>,
    bytes: Vec<u8>,
    size: usize,
}

impl Assembler {
    /// One plain fragment. The whole message once its last fragment arrives.
    pub fn push(&mut self, plain: &[u8]) -> Result<Option<(Kind, Vec<u8>)>, RelayError> {
        if plain.len() < 2 {
            return Err(invalid_fragment());
        }
        let flag = plain[0];
        if flag > 5 {
            return Err(invalid_fragment());
        }
        let last = flag % 2 == 1;
        if !last && plain.len() != FULL_PLAIN {
            return Err(invalid_fragment());
        }
        let kind = Kind::of_flag(flag - flag % 2).ok_or_else(invalid_fragment)?;
        match self.kind {
            Some(seen) if seen != kind => {
                return Err(RelayError::Protocol("Mixed fragment kinds"));
            }
            Some(_) => {}
            None => self.kind = Some(kind),
        }
        self.size += plain.len() - 1;
        if kind == Kind::Binary && self.size > BINARY_MESSAGE_LIMIT {
            return Err(RelayError::Protocol("Binary message too large"));
        }
        if self.size > LOGICAL_MESSAGE_LIMIT {
            return Err(RelayError::Protocol("Logical message too large"));
        }
        self.bytes.extend_from_slice(&plain[1..]);
        if !last {
            return Ok(None);
        }
        self.kind = None;
        self.size = 0;
        Ok(Some((kind, std::mem::take(&mut self.bytes))))
    }
}

fn invalid_fragment() -> RelayError {
    RelayError::Protocol("Invalid encrypted fragment")
}

/// A JSON message deflated alone at level 6, only when that makes it smaller.
pub fn deflate(json: &[u8]) -> Option<Vec<u8>> {
    if json.len() < DEFLATE_THRESHOLD {
        return None;
    }
    let mut encoder = flate2::write::DeflateEncoder::new(Vec::new(), flate2::Compression::new(6));
    encoder.write_all(json).ok()?;
    let deflated = encoder.finish().ok()?;
    if deflated.len() < json.len() {
        Some(deflated)
    } else {
        None
    }
}

/// A peer's deflated message, never past the logical message limit.
fn inflate(deflated: &[u8]) -> Result<Vec<u8>, RelayError> {
    let mut decoder = flate2::read::DeflateDecoder::new(deflated);
    let mut inflated = Vec::new();
    decoder
        .by_ref()
        .take(LOGICAL_MESSAGE_LIMIT as u64 + 1)
        .read_to_end(&mut inflated)
        .map_err(|_| RelayError::Protocol("Invalid message"))?;
    if inflated.len() > LOGICAL_MESSAGE_LIMIT {
        return Err(RelayError::Protocol("Logical message too large"));
    }
    Ok(inflated)
}

/// What one received frame produced: a credit to write back, and/or one whole message.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct Received {
    /// A credit fragment to seal and write, ahead of any data still waiting for credit.
    pub credit: Option<Vec<u8>>,
    pub message: Option<Message>,
}

/// One channel's non-I/O state: the two cipher directions, their rekey counts, both credit
/// accounts and the message being assembled.
pub struct Codec {
    keys: SessionKeys,
    sent: u64,
    received: u64,
    send_flow: FlowCredit,
    receive_flow: FlowCredit,
    assembler: Assembler,
}

impl Codec {
    pub fn new(keys: SessionKeys) -> Self {
        Self {
            keys,
            sent: 0,
            received: 0,
            send_flow: FlowCredit::default(),
            receive_flow: FlowCredit::default(),
            assembler: Assembler::default(),
        }
    }

    /// The peer said it takes credit fragments (`hello.flowControl` has `credit`): from now on
    /// both directions are flow controlled. The start credit to seal and write, once.
    pub fn start_flow_control(&mut self) -> Option<Vec<u8>> {
        self.send_flow.start()
    }

    /// Whether a fragment of `cost` may be written now; the shell reads (to take credits) until
    /// it may.
    pub fn may_send(&self, cost: usize) -> bool {
        self.send_flow.allows(cost)
    }

    pub fn spend(&mut self, cost: usize) {
        self.send_flow.spend(cost);
    }

    /// One logical message as the plain fragments to seal, deflated when `compress` asks and that
    /// shrinks it.
    pub fn outbound(
        &self,
        kind: Kind,
        payload: &[u8],
        compress: bool,
    ) -> Result<Vec<Vec<u8>>, RelayError> {
        if compress
            && kind == Kind::Json
            && let Some(deflated) = deflate(payload)
        {
            return fragments(Kind::Deflated, &deflated);
        }
        fragments(kind, payload)
    }

    /// Seal one fragment; a frame that reaches `REKEY_INTERVAL` rekeys the send direction.
    pub fn seal(&mut self, plain: &[u8]) -> Result<Vec<u8>, RelayError> {
        let sealed = self.keys.send(plain)?;
        self.sent += 1;
        if self.sent.is_multiple_of(REKEY_INTERVAL) {
            self.keys.rekey_send()?;
        }
        Ok(sealed)
    }

    /// One sealed frame from the peer: a credit comes back as a frame to write, or a data
    /// fragment is added to the message being assembled.
    pub fn open(&mut self, sealed: &[u8]) -> Result<Received, RelayError> {
        let plain = Zeroizing::new(self.keys.receive(sealed)?);
        self.received += 1;
        if self.received.is_multiple_of(REKEY_INTERVAL) {
            self.keys.rekey_receive()?;
        }
        if plain.first() == Some(&CREDIT_FLAG) {
            let amount = read_credit(&plain).map_err(RelayError::Protocol)?;
            return Ok(Received {
                credit: self.send_flow.credited(amount),
                message: None,
            });
        }
        let cost = fragment_cost(plain.len());
        if !self.receive_flow.received(cost) {
            return Err(RelayError::Protocol("Peer overran its flow window"));
        }
        let complete = self.assembler.push(&plain)?;
        let credit = self.receive_flow.consumed(cost);
        let message = match complete {
            Some((kind, bytes)) => Some(decode(kind, bytes)?),
            None => None,
        };
        Ok(Received { credit, message })
    }
}

/// A whole message's bytes as its handler takes them.
fn decode(kind: Kind, bytes: Vec<u8>) -> Result<Message, RelayError> {
    if kind == Kind::Binary {
        return Ok(Message::Binary(bytes));
    }
    let bytes = match kind {
        Kind::Deflated => inflate(&bytes)?,
        Kind::Json | Kind::Binary => bytes,
    };
    String::from_utf8(bytes)
        .map(Message::Text)
        .map_err(|_| RelayError::Protocol("Invalid message"))
}

#[cfg(test)]
mod tests;
