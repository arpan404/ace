// SPDX-License-Identifier: Apache-2.0
//! Noise revision 34 over RustCrypto primitives, replacing `@ace/secure-channel` (ADR 0155) and
//! `snow` (which keeps its DH private keys and cipher keys in plain arrays with no erasure). Here
//! every private key, chaining key and cipher key the daemon owns is a `Zeroizing` buffer, the
//! handshake state wipes itself when it ends or fails, and the NK first message's plaintext is
//! returned in a `Zeroizing` buffer so its caller can drop it wiped.
//!
//! `XX` carries a relay stream (the client pins the daemon's static key by its host id) and `NK`
//! a returning client's first message, whose ephemeral key is what replay suppression remembers.
//! A pinned fingerprint is checked as soon as the responder's static key arrives, before the same
//! message's payload is opened.

use chacha20poly1305::aead::{Aead, KeyInit, Payload};
use chacha20poly1305::{ChaCha20Poly1305, Key, Nonce};
use hmac::{Hmac, Mac};
use sha2::{Digest, Sha256};
use zeroize::Zeroizing;

use crate::error::RelayError;

mod nk;
mod xx;

pub use nk::NoiseNk;
pub use xx::NoiseXx;

pub const XX_PROTOCOL: &str = "Noise_XX_25519_ChaChaPoly_SHA256";
pub const NK_PROTOCOL: &str = "Noise_NK_25519_ChaChaPoly_SHA256";

pub use crate::cipher::MAX_MESSAGE;
/// The size of an NK first message with an empty payload: `e` plus the tag.
pub const NK_FIRST_MESSAGE_MINIMUM: usize = 48;

/// A static or ephemeral X25519 key pair. The private half is wiped on drop, and there is no
/// `Clone`: a key is moved to its one owner.
pub struct KeyPair {
    pub public: [u8; 32],
    private: Zeroizing<[u8; 32]>,
}

impl std::fmt::Debug for KeyPair {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("KeyPair")
            .field(
                "public",
                &ace_keys::host_id(&self.public).unwrap_or_default(),
            )
            .finish_non_exhaustive()
    }
}

impl KeyPair {
    /// The pair a raw private key names.
    pub fn from_private(private: [u8; 32]) -> Self {
        let secret = x25519_dalek::StaticSecret::from(private);
        let public = x25519_dalek::PublicKey::from(&secret).to_bytes();
        Self {
            public,
            private: Zeroizing::new(private),
        }
    }

    /// A fresh pair from bytes the shell's CSPRNG produced (`entropy` must give 32).
    pub fn generate(entropy: &dyn Fn(usize) -> Vec<u8>) -> Result<Self, RelayError> {
        let bytes = entropy(32);
        let private: [u8; 32] = bytes
            .as_slice()
            .try_into()
            .map_err(|_| RelayError::Noise("the entropy source did not give 32 bytes"))?;
        Ok(Self::from_private(private))
    }

    pub fn private(&self) -> &[u8; 32] {
        &self.private
    }

    /// Another handle on the same static key, for one more handshake. The private half is copied
    /// into a fresh `Zeroizing` buffer, so both handles wipe themselves.
    pub fn reopen(&self) -> Self {
        Self::from_private(*self.private)
    }

    /// The host id a static key names: base32 of its SHA-256 (`hostId`/`fingerprint`).
    pub fn host_id(&self) -> String {
        host_id(&self.public)
    }
}

/// The handshake's ephemeral, from the I/O boundary (a vector for a test). The crate never draws
/// randomness itself.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Ephemeral {
    Provided([u8; 32]),
}

impl Ephemeral {
    fn key(self) -> KeyPair {
        KeyPair::from_private(match self {
            Self::Provided(private) => private,
        })
    }
}

/// The host id (and pin) of a static public key: uppercase base32 of its SHA-256.
pub fn host_id(public_key: &[u8]) -> String {
    ace_keys::host_id(public_key).unwrap_or_default()
}

/// The fingerprint a pairing link carries is the same value.
pub fn fingerprint(public_key: &[u8]) -> String {
    host_id(public_key)
}

/// A finished handshake's two cipher states; each zeroizes its key when dropped.
pub struct SessionKeys {
    send: crate::cipher::CipherState,
    receive: crate::cipher::CipherState,
    remote_static: Option<[u8; 32]>,
    handshake_hash: [u8; 32],
}

impl SessionKeys {
    pub fn send(&mut self, plain: &[u8]) -> Result<Vec<u8>, RelayError> {
        self.send.encrypt(plain, &[])
    }

    pub fn receive(&mut self, sealed: &[u8]) -> Result<Vec<u8>, RelayError> {
        self.receive.decrypt(sealed, &[])
    }

    pub fn rekey_send(&mut self) -> Result<(), RelayError> {
        self.send.rekey()
    }

    pub fn rekey_receive(&mut self) -> Result<(), RelayError> {
        self.receive.rekey()
    }

    pub fn remote_static(&self) -> Option<&[u8; 32]> {
        self.remote_static.as_ref()
    }

    pub fn handshake_hash(&self) -> &[u8; 32] {
        &self.handshake_hash
    }
}

impl std::fmt::Debug for SessionKeys {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SessionKeys").finish_non_exhaustive()
    }
}

/// The protocol name as the initial hash: exactly 32 bytes when it is, SHA-256 otherwise.
fn initial_hash(protocol: &str) -> [u8; 32] {
    let name = protocol.as_bytes();
    let mut hash = [0u8; 32];
    if name.len() == 32 {
        hash.copy_from_slice(name);
    } else {
        hash = Sha256::digest(name).into();
    }
    hash
}

fn sha256(parts: &[&[u8]]) -> [u8; 32] {
    let mut digest = Sha256::new();
    for part in parts {
        digest.update(part);
    }
    digest.finalize().into()
}

/// `HKDF(ck, ikm, "", 64)`: extract with `ck` as the salt, expand to two 32-byte keys.
fn derive(ck: &[u8; 32], ikm: &[u8]) -> Result<([u8; 32], Zeroizing<[u8; 32]>), RelayError> {
    let prk = {
        let mut mac = <Hmac<Sha256> as hmac::digest::KeyInit>::new_from_slice(ck)
            .map_err(|_| RelayError::Noise("HKDF refused the chaining key"))?;
        mac.update(ikm);
        mac.finalize().into_bytes()
    };
    let read = {
        let mut mac = <Hmac<Sha256> as hmac::digest::KeyInit>::new_from_slice(&prk)
            .map_err(|_| RelayError::Noise("HKDF refused the chaining key"))?;
        mac.update(&[1]);
        mac.finalize().into_bytes()
    };
    let write = {
        let mut mac = <Hmac<Sha256> as hmac::digest::KeyInit>::new_from_slice(&prk)
            .map_err(|_| RelayError::Noise("HKDF refused the chaining key"))?;
        mac.update(&read);
        mac.update(&[2]);
        mac.finalize().into_bytes()
    };
    let mut first = [0u8; 32];
    first.copy_from_slice(&read);
    let mut second = [0u8; 32];
    second.copy_from_slice(&write);
    Ok((first, Zeroizing::new(second)))
}

fn seal(key: &[u8; 32], nonce: u64, ad: &[u8], plain: &[u8]) -> Result<Vec<u8>, RelayError> {
    let mut bytes = [0u8; 12];
    bytes[4..].copy_from_slice(&nonce.to_le_bytes());
    ChaCha20Poly1305::new(&Key::from(*key))
        .encrypt(
            &Nonce::from(bytes),
            Payload {
                msg: plain,
                aad: ad,
            },
        )
        .map_err(|_| RelayError::Noise("Noise encryption failed"))
}

fn open(key: &[u8; 32], nonce: u64, ad: &[u8], sealed: &[u8]) -> Result<Vec<u8>, RelayError> {
    let mut bytes = [0u8; 12];
    bytes[4..].copy_from_slice(&nonce.to_le_bytes());
    ChaCha20Poly1305::new(&Key::from(*key))
        .decrypt(
            &Nonce::from(bytes),
            Payload {
                msg: sealed,
                aad: ad,
            },
        )
        .map_err(|_| RelayError::Noise("Noise decryption failed"))
}

/// The handshake's hashing, chaining key and current cipher key.
struct Symmetric {
    h: [u8; 32],
    ck: Zeroizing<[u8; 32]>,
    key: Option<Zeroizing<[u8; 32]>>,
    nonce: u64,
}

impl Symmetric {
    fn new(protocol: &str, prologue: &[u8]) -> Self {
        let h = initial_hash(protocol);
        let mut sym = Self {
            h,
            ck: Zeroizing::new(h),
            key: None,
            nonce: 0,
        };
        sym.mix_hash(prologue);
        sym
    }

    fn mix_hash(&mut self, data: &[u8]) {
        self.h = sha256(&[&self.h, data]);
    }

    /// `DH(private, remote)` then `(ck, k) = HKDF(ck, dh)`; the cipher starts at nonce 0.
    fn mix_key(&mut self, private: &[u8; 32], remote: &[u8; 32]) -> Result<(), RelayError> {
        let secret = x25519_dalek::StaticSecret::from(*private);
        let shared = Zeroizing::new(
            secret
                .diffie_hellman(&x25519_dalek::PublicKey::from(*remote))
                .to_bytes(),
        );
        let (ck, key) = derive(&self.ck, &*shared)?;
        self.ck = Zeroizing::new(ck);
        self.key = Some(key);
        self.nonce = 0;
        Ok(())
    }

    fn encrypt(&mut self, plain: &[u8]) -> Result<Vec<u8>, RelayError> {
        // Before the first `mixKey` the cipher has no key: Noise passes the bytes through, and
        // the hash still covers what goes on the wire.
        let Some(key) = self.key.as_ref() else {
            let out = plain.to_vec();
            self.mix_hash(&out);
            return Ok(out);
        };
        let sealed = seal(key, self.nonce, &self.h, plain)?;
        self.nonce += 1;
        self.mix_hash(&sealed);
        Ok(sealed)
    }

    fn decrypt(&mut self, sealed: &[u8]) -> Result<Zeroizing<Vec<u8>>, RelayError> {
        let Some(key) = self.key.as_ref() else {
            let out = Zeroizing::new(sealed.to_vec());
            self.mix_hash(sealed);
            return Ok(out);
        };
        let opened = Zeroizing::new(open(key, self.nonce, &self.h, sealed)?);
        self.nonce += 1;
        self.mix_hash(sealed);
        Ok(opened)
    }

    /// `Split()`: `(k1, k2) = HKDF(ck, "")`, initiator sends k1 and receives k2.
    fn split(
        &mut self,
        initiator: bool,
    ) -> Result<(crate::cipher::CipherState, crate::cipher::CipherState), RelayError> {
        let (k1, k2) = derive(&self.ck, &[])?;
        let mut first = [0u8; 32];
        first.copy_from_slice(&k1);
        let send = if initiator { first } else { *k2 };
        let receive = if initiator { *k2 } else { first };
        Ok((
            crate::cipher::CipherState::keyed(send),
            crate::cipher::CipherState::keyed(receive),
        ))
    }

    fn wipe(&mut self) {
        self.h = [0u8; 32];
        self.ck = Zeroizing::new([0u8; 32]);
        self.key = None;
        self.nonce = 0;
    }
}

fn split(
    sym: &mut Symmetric,
    initiator: bool,
    remote_static: Option<[u8; 32]>,
) -> Result<SessionKeys, RelayError> {
    let handshake_hash = sym.h;
    let (send, receive) = sym.split(initiator)?;
    sym.wipe();
    Ok(SessionKeys {
        send,
        receive,
        remote_static,
        handshake_hash,
    })
}

#[cfg(test)]
mod tests;
