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
    pub fn encrypt(&mut self, plain: &[u8], ad: &[u8]) -> Result<Vec<u8>, Error> {
        self.check(plain.len().saturating_add(16))?;
        let key = self.key.as_ref().ok_or(Error::Closed)?;
        let mut out = Vec::with_capacity(plain.len() + 16);
        out.extend_from_slice(plain);
        key.cipher()
            .seal_in_place_append_tag(
                Nonce::assume_unique_for_key(nonce_bytes(self.nonce)),
                Aad::from(ad),
                &mut out,
            )
            .map_err(|_| Error::Authentication)?;
        self.nonce += 1;
        Ok(out)
    }
    pub fn decrypt(&mut self, sealed: &[u8], ad: &[u8]) -> Result<Zeroizing<Vec<u8>>, Error> {
        self.check(sealed.len())?;
        let key = self.key.as_ref().ok_or(Error::Closed)?;
        let mut out = Zeroizing::new(sealed.to_vec());
        let length = key
            .cipher()
            .open_in_place(
                Nonce::assume_unique_for_key(nonce_bytes(self.nonce)),
                Aad::from(ad),
                &mut out,
            )
            .map_err(|_| Error::Authentication)?
            .len();
        out.truncate(length);
        self.nonce += 1;
        Ok(out)
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
