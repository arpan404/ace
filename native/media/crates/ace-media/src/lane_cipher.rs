// SPDX-License-Identifier: Apache-2.0
//! Lanes after their hello: every byte, the accept byte included, in authenticated encryption,
//! so a process that relays the hello between the daemon and ace-media (a squatting instance of
//! a Windows pipe name) can neither read a lane nor get a frame of its own accepted.
//!
//! Keys: HKDF-SHA256 from the lane secret, salt [`KEY_SALT`], over the authenticated transcript
//! (the tag and both nonces) and a direction label, one key each way. Records: a u16 BE length,
//! then a ChaCha20-Poly1305 record from `media-noise`'s transport (Noise CipherState nonces,
//! which are the per-direction sequence numbers; rekeyed every [`media_noise::REKEY_INTERVAL`]
//! records, far before a nonce could repeat). A record that fails to open (modified, out of
//! sequence, replayed, injected or truncated) closes the lane. Vectors:
//! `vectors/lane/proofs.json`.
use crate::secret::LaneSecret;
use media_noise::{Error, Transport};
use media_wire::lane::NONCE_LEN;
use zeroize::Zeroizing;

pub const KEY_SALT: &[u8] = b"ace-media lane v1 keys";
pub const TO_MEDIA: &[u8] = b"daemon to media";
pub const TO_DAEMON: &[u8] = b"media to daemon";
/// The largest plaintext one record carries: a Noise message is at most 65535 bytes, tag
/// included.
pub const MAX_PLAIN: usize = media_noise::MAX_MESSAGE - 16;
/// ace-media's accept byte, the first record it seals on a lane.
pub const LANE_ACCEPTED_PLAIN: u8 = media_wire::lane::ACCEPTED;

pub struct LaneKeys {
    pub to_media: Zeroizing<[u8; 32]>,
    pub to_daemon: Zeroizing<[u8; 32]>,
}

/// The lane's keys from the secret and the hello's transcript.
pub fn derive(
    secret: &LaneSecret,
    tag: u8,
    client_nonce: &[u8; NONCE_LEN],
    server_nonce: &[u8; NONCE_LEN],
) -> LaneKeys {
    let key =
        |label: &[u8]| secret.derive_key(KEY_SALT, &[&[tag], client_nonce, server_nonce, label]);
    LaneKeys {
        to_media: key(TO_MEDIA),
        to_daemon: key(TO_DAEMON),
    }
}

/// One side of a lane's record layer.
pub struct Records<const INTERVAL: u64 = { media_noise::REKEY_INTERVAL }> {
    transport: Transport<INTERVAL>,
    /// Reused for every record: sealing allocates nothing once it has grown.
    scratch: Vec<u8>,
}

impl<const INTERVAL: u64> Records<INTERVAL> {
    /// ace-media's side: it seals toward the daemon and opens what comes to it.
    pub fn media_side(keys: LaneKeys) -> Result<Self, Error> {
        Self::new(keys.to_daemon, keys.to_media)
    }

    /// The daemon's side (tests; the daemon's own is `lanes.ts`).
    pub fn daemon_side(keys: LaneKeys) -> Result<Self, Error> {
        Self::new(keys.to_media, keys.to_daemon)
    }

    fn new(send: Zeroizing<[u8; 32]>, receive: Zeroizing<[u8; 32]>) -> Result<Self, Error> {
        Ok(Self {
            transport: Transport::from_keys(send, receive)?,
            scratch: Vec::with_capacity(MAX_PLAIN + 16),
        })
    }

    /// Appends one record carrying `plain` (at most [`MAX_PLAIN`] bytes) to `out`.
    pub fn seal(&mut self, plain: &[u8], out: &mut Vec<u8>) -> Result<(), Error> {
        if plain.len() > MAX_PLAIN {
            return Err(Error::TooLarge);
        }
        self.scratch.clear();
        self.scratch.extend_from_slice(plain);
        self.transport.seal_in_place(&mut self.scratch)?;
        let length = u16::try_from(self.scratch.len()).map_err(|_| Error::TooLarge)?;
        out.extend_from_slice(&length.to_be_bytes());
        out.extend_from_slice(&self.scratch);
        Ok(())
    }

    /// Opens one record's body (the bytes after its length) in place. Any failure closes the
    /// lane for good: every later record is refused too.
    pub fn open<'a>(&mut self, body: &'a mut [u8]) -> Result<&'a mut [u8], Error> {
        self.transport.open_in_place(body)
    }
}

#[cfg(test)]
#[path = "lane_cipher_tests.rs"]
mod tests;
