// SPDX-License-Identifier: Apache-2.0
use crate::{Error, memory::Key};
use ring::aead::{Aad, Nonce};
use zeroize::{Zeroize, Zeroizing};
pub const MAX_MESSAGE: usize = 65535;
/// Ordered keyed Noise CipherState. No handshake or unkeyed mode.
pub struct CipherState {
    key: Option<Key>,
    nonce: u64,
}
fn nonce_bytes(n: u64) -> [u8; 12] {
    let mut bytes = [0; 12];
    bytes[4..].copy_from_slice(&n.to_le_bytes());
    bytes
}
impl CipherState {
    pub fn new(key: Zeroizing<[u8; 32]>, nonce: u64) -> Result<Self, Error> {
        Ok(Self {
            key: Some(Key::new(key)?),
            nonce,
        })
    }
    fn check(&mut self, length: usize) -> Result<(), Error> {
        if self.key.is_none() || self.nonce == u64::MAX {
            self.close();
            return Err(Error::Closed);
        }
        if length > MAX_MESSAGE {
            return Err(Error::TooLarge);
        }
        Ok(())
    }
    /// Copying wrapper over `encrypt_in_place`; the plaintext copy is wiped on failure.
    pub fn encrypt(&mut self, plain: &[u8], ad: &[u8]) -> Result<Vec<u8>, Error> {
        let mut out = Zeroizing::new(Vec::with_capacity(plain.len() + 16));
        out.extend_from_slice(plain);
        self.encrypt_in_place(&mut out, ad)?;
        Ok(std::mem::take(&mut *out))
    }
    /// Encrypts `buffer` in place and appends the tag; no plaintext remains in it
    /// afterwards. On any failure the buffer is wiped and emptied. Without 16 bytes of
    /// spare capacity it moves once to a larger allocation, wiping the old one.
    pub fn encrypt_in_place(&mut self, buffer: &mut Vec<u8>, ad: &[u8]) -> Result<(), Error> {
        let result = self.seal_into(buffer, ad);
        if result.is_err() {
            buffer.zeroize();
        }
        result
    }
    fn seal_into(&mut self, buffer: &mut Vec<u8>, ad: &[u8]) -> Result<(), Error> {
        self.check(buffer.len().saturating_add(16))?;
        let key = self.key.as_ref().ok_or(Error::Closed)?;
        if buffer.capacity() - buffer.len() < 16 {
            let mut grown = Vec::with_capacity(buffer.len() + 16);
            grown.extend_from_slice(buffer);
            buffer.zeroize();
            *buffer = grown;
        }
        let tag = key
            .cipher()
            .seal_in_place_separate_tag(
                Nonce::assume_unique_for_key(nonce_bytes(self.nonce)),
                Aad::from(ad),
                buffer,
            )
            .map_err(|_| Error::Authentication)?;
        // Capacity is reserved above, so appending the tag never reallocates.
        buffer.extend_from_slice(tag.as_ref());
        self.nonce += 1;
        Ok(())
    }
    /// Copying wrapper over `decrypt_in_place`; the result is wiped on drop.
    pub fn decrypt(&mut self, sealed: &[u8], ad: &[u8]) -> Result<Zeroizing<Vec<u8>>, Error> {
        let mut out = Zeroizing::new(sealed.to_vec());
        let length = self.decrypt_in_place(&mut out, ad)?.len();
        out.truncate(length);
        Ok(out)
    }
    /// Decrypts `buffer` (ciphertext and tag) in place and returns the plaintext
    /// prefix. The caller owns wiping the buffer after success; on any failure the
    /// whole buffer is wiped.
    pub fn decrypt_in_place<'a>(
        &mut self,
        buffer: &'a mut [u8],
        ad: &[u8],
    ) -> Result<&'a mut [u8], Error> {
        if let Err(e) = self.check(buffer.len()) {
            buffer.zeroize();
            return Err(e);
        }
        let Some(key) = self.key.as_ref() else {
            buffer.zeroize();
            return Err(Error::Closed);
        };
        let nonce = Nonce::assume_unique_for_key(nonce_bytes(self.nonce));
        match key
            .cipher()
            .open_in_place(nonce, Aad::from(ad), &mut *buffer)
        {
            Ok(plain) => {
                let length = plain.len();
                self.nonce += 1;
                Ok(&mut buffer[..length])
            }
            Err(_) => {
                buffer.zeroize();
                Err(Error::Authentication)
            }
        }
    }
    /// Noise REKEY uses the reserved nonce and does not reset the next nonce. The new
    /// key is derived in a fixed, wiped array; the tag is discarded.
    pub fn rekey(&mut self) -> Result<(), Error> {
        self.check(0)?;
        let key = self.key.as_mut().ok_or(Error::Closed)?;
        let mut next = Zeroizing::new([0_u8; 32]);
        let _tag = key
            .cipher()
            .seal_in_place_separate_tag(
                Nonce::assume_unique_for_key(nonce_bytes(u64::MAX)),
                Aad::empty(),
                &mut next[..],
            )
            .map_err(|_| Error::Authentication)?;
        key.replace(&next[..])?;
        Ok(())
    }
    pub fn close(&mut self) {
        self.key = None;
    }
}
