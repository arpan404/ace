// SPDX-License-Identifier: Apache-2.0
use crate::{CipherState, Error, FlowCredit, MAX_MESSAGE};
use media_wire::keys::KeyBlock;
use zeroize::Zeroizing;
pub const REKEY_INTERVAL: u64 = 1 << 20;
const CHUNK: usize = MAX_MESSAGE - 17;
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(u8)]
pub enum FragmentKind {
    Json = 0,
    Binary = 2,
    Deflated = 4,
}
pub struct Fragment<'a> {
    pub kind: FragmentKind,
    pub last: bool,
    pub data: &'a [u8],
}
impl<'a> Fragment<'a> {
    pub fn decode(plain: &'a [u8]) -> Result<Self, Error> {
        if plain.len() < 2
            || plain.len() > MAX_MESSAGE - 16
            || plain[0] > 5
            || (plain[0] & 1 == 0 && plain.len() != MAX_MESSAGE - 16)
        {
            return Err(Error::InvalidFragment);
        }
        let kind = match plain[0] / 2 {
            0 => FragmentKind::Json,
            1 => FragmentKind::Binary,
            _ => FragmentKind::Deflated,
        };
        Ok(Self {
            kind,
            last: plain[0] & 1 != 0,
            data: &plain[1..],
        })
    }
}
/// Fragment plaintexts lazily; credits can be sent between fragments by the socket owner.
pub struct Fragments<'a> {
    data: &'a [u8],
    kind: FragmentKind,
}
impl<'a> Fragments<'a> {
    pub fn new(data: &'a [u8], kind: FragmentKind) -> Result<Self, Error> {
        let limit = if kind == FragmentKind::Binary {
            64 * 1024 + 16
        } else {
            16 * 1024 * 1024
        };
        if data.len() > limit {
            return Err(Error::TooLarge);
        }
        Ok(Self { data, kind })
    }
}
impl Iterator for Fragments<'_> {
    type Item = Zeroizing<Vec<u8>>;
    fn next(&mut self) -> Option<Self::Item> {
        if self.data.is_empty() {
            return None;
        }
        let n = self.data.len().min(CHUNK);
        let mut plain = Zeroizing::new(Vec::with_capacity(n + 1));
        plain.push(self.kind as u8 + u8::from(n == self.data.len()));
        plain.extend_from_slice(&self.data[..n]);
        self.data = &self.data[n..];
        Some(plain)
    }
}
/// Cipher framing only; the caller owns authorization, scheduling, queues and credit accounting.
/// Credit frames must pass through seal/open too, so they count towards rekeying.
pub type RelayStream = Transport<REKEY_INTERVAL>;
pub struct Transport<const INTERVAL: u64> {
    send: CipherState,
    receive: CipherState,
    sent: u64,
    received: u64,
    pub flow: FlowCredit,
}
impl<const INTERVAL: u64> Transport<INTERVAL> {
    /// Own and wipe the entire control payload, including on decode failure.
    pub fn import(payload: Zeroizing<Vec<u8>>) -> Result<Self, Error> {
        if INTERVAL == 0 {
            return Err(Error::InvalidKeyBlock);
        }
        let block = KeyBlock::decode(&payload).map_err(|_| Error::InvalidKeyBlock)?;
        drop(payload);
        let flow = FlowCredit::import(&block)?;
        Ok(Self {
            send: CipherState::new(block.send_key, block.send_nonce)?,
            receive: CipherState::new(block.receive_key, block.receive_nonce)?,
            sent: block.frames_sent,
            received: block.frames_received,
            flow,
        })
    }
    pub fn seal(&mut self, plain: &[u8]) -> Result<Vec<u8>, Error> {
        let result = self.send.encrypt(plain, &[])?;
        self.sent = self.sent.wrapping_add(1);
        if self.sent.is_multiple_of(INTERVAL) {
            self.send.rekey()?;
        }
        Ok(result)
    }
    pub fn open(&mut self, sealed: &[u8]) -> Result<Zeroizing<Vec<u8>>, Error> {
        let result = self.receive.decrypt(sealed, &[]);
        let plain = match result {
            Ok(p) => p,
            Err(e) => {
                self.close();
                return Err(e);
            }
        };
        self.received = self.received.wrapping_add(1);
        if self.received.is_multiple_of(INTERVAL) {
            self.receive.rekey()?;
        }
        Ok(plain)
    }
    pub fn close(&mut self) {
        self.send.close();
        self.receive.close();
    }
}
