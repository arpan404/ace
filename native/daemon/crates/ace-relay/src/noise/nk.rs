// SPDX-License-Identifier: Apache-2.0
//! Noise NK (`<- s; ...; -> e, es; <- e, ee`): the initiator knows the responder's static key in
//! advance, so its first message is already encrypted to it, and its ephemeral key is what replay
//! suppression remembers. The first message's plaintext comes back in a `Zeroizing` buffer.

use zeroize::Zeroizing;

use super::{
    Ephemeral, KeyPair, MAX_MESSAGE, NK_FIRST_MESSAGE_MINIMUM, NK_PROTOCOL, SessionKeys, Symmetric,
    split,
};
use crate::error::RelayError;

/// Noise NK, one turn at a time.
pub struct NoiseNk {
    initiator: bool,
    step: u8,
    failed: bool,
    sym: Symmetric,
    static_key: Option<KeyPair>,
    ephemeral: Option<KeyPair>,
    remote_ephemeral: Option<[u8; 32]>,
    /// The initiator's copy of the responder's static key, for the first `es`.
    remote_static: Option<[u8; 32]>,
    transport: Option<SessionKeys>,
    handshake_hash: [u8; 32],
}

impl NoiseNk {
    /// The client: the responder's static key is known before the handshake, so it binds both
    /// ends' hashes with it.
    pub fn initiator(remote_static: &[u8; 32], ephemeral: Ephemeral, prologue: &[u8]) -> Self {
        let mut sym = Symmetric::new(NK_PROTOCOL, prologue);
        sym.mix_hash(remote_static);
        Self {
            initiator: true,
            step: 0,
            failed: false,
            sym,
            static_key: None,
            ephemeral: Some(ephemeral.key()),
            remote_ephemeral: None,
            remote_static: Some(*remote_static),
            transport: None,
            handshake_hash: [0u8; 32],
        }
    }

    /// The daemon: its static key is the one the client pinned.
    pub fn responder(static_key: KeyPair, ephemeral: Ephemeral, prologue: &[u8]) -> Self {
        let mut sym = Symmetric::new(NK_PROTOCOL, prologue);
        sym.mix_hash(&static_key.public);
        Self {
            initiator: false,
            step: 0,
            failed: false,
            sym,
            static_key: Some(static_key),
            ephemeral: Some(ephemeral.key()),
            remote_ephemeral: None,
            remote_static: None,
            transport: None,
            handshake_hash: [0u8; 32],
        }
    }

    fn check(&self, writing: bool) -> Result<(), RelayError> {
        if self.failed || self.step == 2 {
            return Err(RelayError::Noise("Handshake closed"));
        }
        if writing != (self.initiator == (self.step == 0)) {
            return Err(RelayError::Noise("Wrong handshake turn"));
        }
        Ok(())
    }

    /// Ends the handshake for good, wiping what it held, and keeps the failure's own reason.
    fn poison(&mut self) {
        self.failed = true;
        self.sym.wipe();
        self.static_key = None;
        self.ephemeral = None;
    }

    fn own_ephemeral(&self) -> Result<&KeyPair, RelayError> {
        self.ephemeral
            .as_ref()
            .ok_or(RelayError::Noise("Missing ephemeral key"))
    }

    pub fn write_message(&mut self, payload: &[u8]) -> Result<Vec<u8>, RelayError> {
        self.check(true)?;
        if payload.len() + NK_FIRST_MESSAGE_MINIMUM > MAX_MESSAGE {
            return Err(RelayError::Noise("Noise message too large"));
        }
        match self.write(payload) {
            Ok(message) => Ok(message),
            Err(error) => {
                self.poison();
                Err(error)
            }
        }
    }

    fn write(&mut self, payload: &[u8]) -> Result<Vec<u8>, RelayError> {
        let public = self.own_ephemeral()?.public;
        let private = self.own_ephemeral()?.private().to_owned();
        self.sym.mix_hash(&public);
        if self.step == 0 {
            // The initiator's first message: DH(own ephemeral, the responder's static key).
            let remote = self
                .remote_static
                .ok_or(RelayError::Noise("Missing remote key"))?;
            self.sym.mix_key(&private, &remote)?;
        } else {
            let remote = self
                .remote_ephemeral
                .ok_or(RelayError::Noise("Missing remote key"))?;
            self.sym.mix_key(&private, &remote)?;
        }
        let mut message = Vec::with_capacity(32 + payload.len() + 16);
        message.extend_from_slice(&public);
        message.extend_from_slice(&self.sym.encrypt(payload)?);
        self.step += 1;
        if self.step == 2 {
            self.finish()?;
        }
        Ok(message)
    }

    fn finish(&mut self) -> Result<(), RelayError> {
        self.handshake_hash = self.sym.h;
        let keys = split(&mut self.sym, self.initiator, None)?;
        self.transport = Some(keys);
        self.static_key = None;
        self.ephemeral = None;
        Ok(())
    }

    pub fn read_message(&mut self, message: &[u8]) -> Result<Zeroizing<Vec<u8>>, RelayError> {
        self.check(false)?;
        if message.len() < NK_FIRST_MESSAGE_MINIMUM || message.len() > MAX_MESSAGE {
            self.failed = true;
            self.sym.wipe();
            self.static_key = None;
            self.ephemeral = None;
            return Err(RelayError::Noise("Invalid Noise message size"));
        }
        match self.read(message) {
            Ok(payload) => Ok(payload),
            Err(error) => {
                self.poison();
                Err(error)
            }
        }
    }

    fn read(&mut self, message: &[u8]) -> Result<Zeroizing<Vec<u8>>, RelayError> {
        let mut remote = [0u8; 32];
        remote.copy_from_slice(&message[..32]);
        self.remote_ephemeral = Some(remote);
        self.sym.mix_hash(&remote);
        if self.step == 0 {
            // The responder: DH(own static, e).
            let static_private = self
                .static_key
                .as_ref()
                .map(|static_key| static_key.private().to_owned())
                .ok_or(RelayError::Noise("Missing static key"))?;
            self.sym.mix_key(&static_private, &remote)?;
        } else {
            // The initiator: DH(own ephemeral, re).
            let ephemeral = self.own_ephemeral()?.private().to_owned();
            self.sym.mix_key(&ephemeral, &remote)?;
        }
        let payload = self.sym.decrypt(&message[32..])?;
        self.step += 1;
        if self.step == 2 {
            self.finish()?;
        }
        Ok(payload)
    }

    /// The first message's ephemeral key, once read: what replay suppression remembers.
    pub fn remote_ephemeral(&self) -> Option<[u8; 32]> {
        self.remote_ephemeral
    }

    pub fn is_finished(&self) -> bool {
        self.transport.is_some()
    }

    pub fn handshake_hash(&self) -> &[u8; 32] {
        &self.handshake_hash
    }

    pub fn into_transport(mut self) -> Result<SessionKeys, RelayError> {
        if self.failed {
            return Err(RelayError::Noise("Handshake closed"));
        }
        self.transport
            .take()
            .ok_or(RelayError::Noise("Handshake incomplete"))
    }
}
