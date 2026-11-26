// SPDX-License-Identifier: Apache-2.0
//! Ordered Noise `CipherState` (`packages/secure-channel/src/cipher.ts`), the cipher state a
//! finished handshake splits into: ChaCha20-Poly1305 under a 12-byte nonce whose last eight bytes
//! count messages, the reserved nonce that exhausts a direction for good, the coordinated
//! directional rekey, a snapshot that resumes the same ordered session, and the media key hand-over
//! that writes key and next nonce into a caller's block.

use chacha20poly1305::aead::{Aead, KeyInit, Payload};
use chacha20poly1305::{ChaCha20Poly1305, Key, Nonce};
use zeroize::{Zeroize, Zeroizing};

use crate::error::RelayError;

/// The largest sealed message either direction carries.
pub const MAX_MESSAGE: usize = 65535;
/// The reserved nonce: reaching it exhausts the direction, and it seals a rekey's key.
const MAX_NONCE: u64 = u64::MAX;

fn nonce_bytes(nonce: u64) -> [u8; 12] {
    let mut bytes = [0u8; 12];
    bytes[4..].copy_from_slice(&nonce.to_le_bytes());
    bytes
}

fn cipher(key: &Zeroizing<[u8; 32]>) -> ChaCha20Poly1305 {
    ChaCha20Poly1305::new(&Key::from(**key))
}

/// One direction's key and next nonce, and nothing else. It is deliberately not `Clone` and not
/// printable: a snapshot is a session's live key, and a copy of it could outlive the state that
/// owns it.
pub struct Snapshot {
    pub key: Zeroizing<[u8; 32]>,
    pub nonce: u64,
}

/// An ordered Noise cipher state. Applications must coordinate directional rekeys.
pub struct CipherState {
    key: Option<Zeroizing<[u8; 32]>>,
    nonce: u64,
    closed: bool,
}

impl Drop for CipherState {
    fn drop(&mut self) {
        self.destroy();
    }
}

impl CipherState {
    /// A state with `key` (none: length-preserving passthrough, as Noise's pre-key state) and the
    /// next nonce, which a hand-over resumes from.
    pub fn new(key: Option<impl Into<Zeroizing<[u8; 32]>>>, initial_nonce: u64) -> Self {
        let key = key.map(Into::into);
        Self {
            key,
            nonce: initial_nonce,
            closed: false,
        }
    }

    /// A state with a key and no messages sent.
    pub fn keyed(key: impl Into<Zeroizing<[u8; 32]>>) -> Self {
        Self::new(Some(key.into()), 0)
    }

    pub fn has_key(&self) -> bool {
        self.key.is_some()
    }

    pub fn nonce(&self) -> u64 {
        self.nonce
    }

    fn check(&mut self, length: usize) -> Result<(), RelayError> {
        if self.closed || self.nonce == MAX_NONCE {
            self.destroy();
            return Err(RelayError::Noise("Cipher exhausted or closed"));
        }
        if length > MAX_MESSAGE {
            return Err(RelayError::Noise("Noise message too large"));
        }
        Ok(())
    }

    pub fn encrypt(&mut self, plaintext: &[u8], ad: &[u8]) -> Result<Vec<u8>, RelayError> {
        let length = plaintext.len() + usize::from(self.key.is_some()) * 16;
        self.check(length)?;
        let Some(key) = self.key.as_ref() else {
            return Ok(plaintext.to_vec());
        };
        let sealed = cipher(key)
            .encrypt(
                &Nonce::from(nonce_bytes(self.nonce)),
                Payload {
                    msg: plaintext,
                    aad: ad,
                },
            )
            .map_err(|_| RelayError::Noise("Cipher encrypt failed"))?;
        self.nonce += 1;
        Ok(sealed)
    }

    pub fn decrypt(&mut self, ciphertext: &[u8], ad: &[u8]) -> Result<Vec<u8>, RelayError> {
        self.check(ciphertext.len())?;
        let Some(key) = self.key.as_ref() else {
            return Ok(ciphertext.to_vec());
        };
        let opened = cipher(key)
            .decrypt(
                &Nonce::from(nonce_bytes(self.nonce)),
                Payload {
                    msg: ciphertext,
                    aad: ad,
                },
            )
            .map_err(|_| RelayError::Noise("Cipher authentication failed"))?;
        // A refused message leaves the nonce where it was: the next one may still be in order.
        self.nonce += 1;
        Ok(opened)
    }

    /// A copy of the key and next nonce, for a holder that must survive losing its memory (a
    /// hibernated relay). `CipherState::new` resumes it.
    pub fn snapshot(&self) -> Result<Snapshot, RelayError> {
        let Some(key) = self.key.as_ref() else {
            return Err(RelayError::Noise("No cipher key"));
        };
        if self.closed {
            return Err(RelayError::Noise("No cipher key"));
        }
        Ok(Snapshot {
            key: Zeroizing::new(**key),
            nonce: self.nonce,
        })
    }

    /// The relay key hand-over (docs/media/plan.md, "Key hand-over"): writes the key at
    /// `key_offset` and the next nonce, a big-endian u64, at `nonce_offset`, straight into the
    /// caller's block, then destroys this state.
    pub fn export_into(
        &mut self,
        block: &mut [u8],
        key_offset: usize,
        nonce_offset: usize,
    ) -> Result<(), RelayError> {
        let Some(key) = self.key.as_ref() else {
            return Err(RelayError::Noise("No cipher key"));
        };
        if self.closed {
            return Err(RelayError::Noise("No cipher key"));
        }
        let fits = |offset: usize, length: usize| offset + length <= block.len();
        if !fits(key_offset, 32) || !fits(nonce_offset, 8) {
            return Err(RelayError::Noise("Export outside the block"));
        }
        // Checked before anything is written: an overlap would put the nonce over key bytes.
        if key_offset < nonce_offset + 8 && nonce_offset < key_offset + 32 {
            return Err(RelayError::Noise("Key and nonce ranges overlap"));
        }
        block[key_offset..key_offset + 32].copy_from_slice(&**key);
        block[nonce_offset..nonce_offset + 8].copy_from_slice(&self.nonce.to_be_bytes());
        self.destroy();
        Ok(())
    }

    /// `rekey = ENCRYPT(key, 2^64-1, empty, zeros[32])[0..32]`, then the old key is wiped. The
    /// sealed output holds the new key, so it is wiped too once the key is taken.
    pub fn rekey(&mut self) -> Result<(), RelayError> {
        self.check(0)?;
        let Some(key) = self.key.as_ref() else {
            return Err(RelayError::Noise("No cipher key"));
        };
        let sealed = Zeroizing::new(
            cipher(key)
                .encrypt(
                    &Nonce::from(nonce_bytes(MAX_NONCE)),
                    Payload {
                        msg: &[0u8; 32],
                        aad: &[],
                    },
                )
                .map_err(|_| RelayError::Noise("Cipher rekey failed"))?,
        );
        let mut next = Zeroizing::new([0u8; 32]);
        next.copy_from_slice(&sealed[..32]);
        if let Some(old) = self.key.as_mut() {
            old.zeroize();
        }
        self.key = Some(next);
        Ok(())
    }

    pub fn destroy(&mut self) {
        if let Some(key) = self.key.as_mut() {
            key.zeroize();
        }
        self.key = None;
        self.closed = true;
    }
}

#[cfg(test)]
mod tests;
