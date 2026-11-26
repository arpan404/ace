// SPDX-License-Identifier: Apache-2.0
//! Noise revision 34 over `snow`, replacing `@ace/secure-channel` (ADR 0155): `XX` for a stream
//! (the client pins the daemon's static key by its host id) and `NK` for a returning client's
//! first message, whose ephemeral key is what replay suppression remembers. A pinned fingerprint
//! is checked as soon as the responder's static key arrives, before any payload is returned.
//!
//! The official XX and NK vectors (`tests/fixtures/`) run against this implementation; the
//! cipher's nonce exhaustion and snapshots (`cipher.ts`) are not part of the handshake and are
//! not ported here.

use std::str::FromStr;

use snow::params::NoiseParams;
use snow::{Builder, TransportState};

use crate::error::RelayError;

mod nk;
mod xx;

pub use nk::NoiseNk;
pub use xx::NoiseXx;

pub const XX_PROTOCOL: &str = "Noise_XX_25519_ChaChaPoly_SHA256";
pub const NK_PROTOCOL: &str = "Noise_NK_25519_ChaChaPoly_SHA256";

/// The largest Noise message either direction carries, transport included (`MAX_MESSAGE`).
pub const MAX_MESSAGE: usize = 65535;
/// The size of an NK first message with an empty payload: `e` plus the tag.
pub const NK_FIRST_MESSAGE_MINIMUM: usize = 48;

/// A static or ephemeral X25519 key pair.
#[derive(Clone, PartialEq, Eq)]
pub struct KeyPair {
    pub private: [u8; 32],
    pub public: [u8; 32],
}

impl std::fmt::Debug for KeyPair {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("KeyPair")
            .field("public", &self.host_id())
            .finish_non_exhaustive()
    }
}

impl KeyPair {
    /// The pair a raw private key names.
    pub fn from_private(private: [u8; 32]) -> Self {
        let secret = x25519_dalek::StaticSecret::from(private);
        let public = x25519_dalek::PublicKey::from(&secret).to_bytes();
        Self { private, public }
    }

    /// A fresh pair from the OS CSPRNG (snow generates it with its resolver).
    pub fn generate() -> Result<Self, RelayError> {
        let params = NoiseParams::from_str(XX_PROTOCOL)
            .map_err(|_| RelayError::Noise("unknown Noise protocol"))?;
        let pair = Builder::new(params)
            .generate_keypair()
            .map_err(|_| RelayError::Noise("the OS CSPRNG failed"))?;
        let private: [u8; 32] = pair
            .private
            .try_into()
            .map_err(|_| RelayError::Noise("a Noise key is not 32 bytes"))?;
        Ok(Self::from_private(private))
    }

    /// The host id a static key names: base32 of its SHA-256 (`hostId`/`fingerprint`, 52 chars).
    pub fn host_id(&self) -> String {
        host_id(&self.public)
    }
}

/// The handshake's fresh ephemeral, or a fixed one for the official vectors.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Ephemeral {
    Fresh,
    /// Only the vectors use this: production never reuses an ephemeral key.
    Fixed([u8; 32]),
}

/// The host id (and pin) of a static public key: uppercase base32 of its SHA-256.
pub fn host_id(public_key: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    data_encoding::BASE32_NOPAD.encode(&Sha256::digest(public_key))
}

/// The fingerprint a pairing link carries is the same value (`fingerprint` in
/// `@ace/secure-channel`).
pub fn fingerprint(public_key: &[u8]) -> String {
    host_id(public_key)
}

pub(super) fn params(protocol: &str) -> Result<NoiseParams, RelayError> {
    NoiseParams::from_str(protocol).map_err(|_| RelayError::Noise("unknown Noise protocol"))
}

/// A finished handshake's two cipher states.
pub struct SessionKeys {
    transport: TransportState,
}

impl SessionKeys {
    pub fn send(&mut self, plain: &[u8]) -> Result<Vec<u8>, RelayError> {
        if plain.len() + 16 > MAX_MESSAGE {
            return Err(RelayError::Noise("Noise message too large"));
        }
        let mut out = vec![0u8; MAX_MESSAGE];
        let len = self
            .transport
            .write_message(plain, &mut out)
            .map_err(|_| RelayError::Noise("Noise send failed"))?;
        out.truncate(len);
        Ok(out)
    }

    pub fn receive(&mut self, sealed: &[u8]) -> Result<Vec<u8>, RelayError> {
        if sealed.len() > MAX_MESSAGE {
            return Err(RelayError::Noise("Noise message too large"));
        }
        let mut out = vec![0u8; MAX_MESSAGE];
        let len = self
            .transport
            .read_message(sealed, &mut out)
            .map_err(|_| RelayError::Noise("Noise receive failed"))?;
        out.truncate(len);
        Ok(out)
    }

    /// Rekeys this direction only, as `CipherState.rekey` does for the sender.
    pub fn rekey_send(&mut self) {
        self.transport.rekey_outgoing();
    }

    pub fn rekey_receive(&mut self) {
        self.transport.rekey_incoming();
    }

    pub fn remote_static(&self) -> Option<&[u8]> {
        self.transport.get_remote_static()
    }
}

#[cfg(test)]
mod tests;
