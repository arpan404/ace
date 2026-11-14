// SPDX-License-Identifier: Apache-2.0
use crate::{Error, memory::Key};
use ring::aead::{Aad, Nonce};
use zeroize::Zeroizing;
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
    /// Copying wrapper over `encrypt_in_place`.
    pub fn encrypt(&mut self, plain: &[u8], ad: &[u8]) -> Result<Vec<u8>, Error> {
        let mut out = Vec::with_capacity(plain.len() + 16);
        out.extend_from_slice(plain);
        self.encrypt_in_place(&mut out, ad)?;
        Ok(out)
    }
    /// Encrypts `buffer` in place and appends the tag. No allocation when the buffer
    /// has 16 bytes of spare capacity; no plaintext remains in it afterwards.
    pub fn encrypt_in_place(&mut self, buffer: &mut Vec<u8>, ad: &[u8]) -> Result<(), Error> {
        self.check(buffer.len().saturating_add(16))?;
        let key = self.key.as_ref().ok_or(Error::Closed)?;
        key.cipher()
            .seal_in_place_append_tag(
                Nonce::assume_unique_for_key(nonce_bytes(self.nonce)),
                Aad::from(ad),
                buffer,
            )
            .map_err(|_| Error::Authentication)?;
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
    /// prefix. The caller owns wiping the buffer.
    pub fn decrypt_in_place<'a>(
        &mut self,
        buffer: &'a mut [u8],
        ad: &[u8],
    ) -> Result<&'a mut [u8], Error> {
        self.check(buffer.len())?;
        let key = self.key.as_ref().ok_or(Error::Closed)?;
        let plain = key
            .cipher()
            .open_in_place(
                Nonce::assume_unique_for_key(nonce_bytes(self.nonce)),
                Aad::from(ad),
                buffer,
            )
            .map_err(|_| Error::Authentication)?;
        self.nonce += 1;
        Ok(plain)
    }
    /// Noise REKEY uses the reserved nonce and does not reset the next nonce.
    pub fn rekey(&mut self) -> Result<(), Error> {
        self.check(0)?;
        let key = self.key.as_mut().ok_or(Error::Closed)?;
        let mut zeros = Zeroizing::new(vec![0; 32]);
        key.cipher()
            .seal_in_place_append_tag(
                Nonce::assume_unique_for_key(nonce_bytes(u64::MAX)),
                Aad::empty(),
                &mut *zeros,
            )
            .map_err(|_| Error::Authentication)?;
        key.replace(&zeros[..32])?;
        Ok(())
    }
    pub fn close(&mut self) {
        self.key = None;
    }
}
