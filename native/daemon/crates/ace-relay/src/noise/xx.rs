// SPDX-License-Identifier: Apache-2.0
//! Noise XX (`-> e; <- e, ee, s, es; -> s, se`), as the relay's streams run it, with the pinned
//! host id checked the moment the responder's static key arrives — before that message's payload
//! is opened.

use super::{KeyPair, MAX_MESSAGE, SessionKeys, Symmetric, XX_PROTOCOL, host_id, split};
use crate::error::RelayError;

/// The size overhead each handshake message carries: e, e+s+tags, s+tags.
fn overhead(step: u8) -> usize {
    match step {
        0 => 32,
        1 => 96,
        _ => 64,
    }
}

/// Noise XX, one turn at a time.
pub struct NoiseXx {
    initiator: bool,
    step: u8,
    failed: bool,
    sym: Symmetric,
    /// Own static and ephemeral keys; dropped (and wiped) when the handshake finishes or fails.
    static_key: Option<KeyPair>,
    ephemeral: Option<KeyPair>,
    remote_ephemeral: Option<[u8; 32]>,
    remote_static: Option<[u8; 32]>,
    pinned: Option<String>,
    transport: Option<SessionKeys>,
    handshake_hash: [u8; 32],
}

impl NoiseXx {
    /// The client: knows the pinned host id, and checks the daemon's static key the moment it
    /// arrives.
    pub fn initiator(
        static_key: KeyPair,
        ephemeral: KeyPair,
        prologue: &[u8],
        pinned: Option<&str>,
    ) -> Self {
        Self {
            initiator: true,
            step: 0,
            failed: false,
            sym: Symmetric::new(XX_PROTOCOL, prologue),
            static_key: Some(static_key),
            ephemeral: Some(ephemeral),
            remote_ephemeral: None,
            remote_static: None,
            pinned: pinned.map(str::to_owned),
            transport: None,
            handshake_hash: [0u8; 32],
        }
    }

    /// The daemon: its static key is the identity the client pinned.
    pub fn responder(static_key: KeyPair, ephemeral: KeyPair, prologue: &[u8]) -> Self {
        Self {
            initiator: false,
            step: 0,
            failed: false,
            sym: Symmetric::new(XX_PROTOCOL, prologue),
            static_key: Some(static_key),
            ephemeral: Some(ephemeral),
            remote_ephemeral: None,
            remote_static: None,
            pinned: None,
            transport: None,
            handshake_hash: [0u8; 32],
        }
    }

    fn check(&self, writing: bool) -> Result<(), RelayError> {
        if self.failed || self.step == 3 {
            return Err(RelayError::Noise("Handshake closed"));
        }
        let initiator_turn = self.step != 1;
        if writing != (self.initiator == initiator_turn) {
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

    fn own_static(&self) -> Result<&KeyPair, RelayError> {
        self.static_key
            .as_ref()
            .ok_or(RelayError::Noise("Missing static key"))
    }

    fn own_ephemeral(&self) -> Result<&KeyPair, RelayError> {
        self.ephemeral
            .as_ref()
            .ok_or(RelayError::Noise("Missing ephemeral key"))
    }

    pub fn write_message(&mut self, payload: &[u8]) -> Result<Vec<u8>, RelayError> {
        self.check(true)?;
        if payload.len() + overhead(self.step) > MAX_MESSAGE {
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
        let mut parts: Vec<u8> = Vec::new();
        if self.step < 2 {
            let public = self.own_ephemeral()?.public;
            parts.extend_from_slice(&public);
            self.sym.mix_hash(&public);
        }
        if self.step == 1 {
            let remote = self
                .remote_ephemeral
                .ok_or(RelayError::Noise("Missing remote key"))?;
            let ephemeral = self
                .ephemeral
                .as_ref()
                .ok_or(RelayError::Noise("Missing ephemeral key"))?;
            self.sym.mix_key(ephemeral, &remote)?;
            let static_public = self.own_static()?.public;
            parts.extend_from_slice(&self.sym.encrypt(&static_public)?);
            let static_key = self
                .static_key
                .as_ref()
                .ok_or(RelayError::Noise("Missing static key"))?;
            self.sym.mix_key(static_key, &remote)?;
        }
        if self.step == 2 {
            let static_public = self.own_static()?.public;
            parts.extend_from_slice(&self.sym.encrypt(&static_public)?);
            // `se`: DH(own static, the responder's ephemeral).
            let remote = self
                .remote_ephemeral
                .ok_or(RelayError::Noise("Missing remote key"))?;
            let static_key = self
                .static_key
                .as_ref()
                .ok_or(RelayError::Noise("Missing static key"))?;
            self.sym.mix_key(static_key, &remote)?;
        }
        parts.extend_from_slice(&self.sym.encrypt(payload)?);
        self.step += 1;
        if self.step == 3 {
            self.finish()?;
        }
        Ok(parts)
    }

    fn finish(&mut self) -> Result<(), RelayError> {
        self.handshake_hash = self.sym.h;
        let keys = split(&mut self.sym, self.initiator, self.remote_static)?;
        self.transport = Some(keys);
        self.static_key = None;
        self.ephemeral = None;
        Ok(())
    }

    pub fn read_message(&mut self, message: &[u8]) -> Result<Vec<u8>, RelayError> {
        self.check(false)?;
        let minimum = overhead(self.step);
        if message.len() < minimum || message.len() > MAX_MESSAGE {
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

    fn read(&mut self, message: &[u8]) -> Result<Vec<u8>, RelayError> {
        let mut offset = 0;
        if self.step < 2 {
            let mut remote = [0u8; 32];
            remote.copy_from_slice(&message[..32]);
            self.remote_ephemeral = Some(remote);
            offset = 32;
            self.sym.mix_hash(&remote);
        }
        if self.step == 1 {
            let remote = self
                .remote_ephemeral
                .ok_or(RelayError::Noise("Missing remote key"))?;
            let ephemeral = self
                .ephemeral
                .as_ref()
                .ok_or(RelayError::Noise("Missing ephemeral key"))?;
            self.sym.mix_key(ephemeral, &remote)?;
        }
        if self.step > 0 {
            let sealed = &message[offset..offset + 48];
            offset += 48;
            let opened = self.sym.decrypt(sealed)?;
            let mut static_key = [0u8; 32];
            static_key.copy_from_slice(&opened);
            self.remote_static = Some(static_key);
            // The pin is checked here, before the payload this same message carries is opened.
            if let Some(pinned) = &self.pinned
                && host_id(&static_key) != *pinned
            {
                return Err(RelayError::Noise("Pinned fingerprint mismatch"));
            }
            let ephemeral = self
                .ephemeral
                .as_ref()
                .ok_or(RelayError::Noise("Missing ephemeral key"))?;
            self.sym.mix_key(ephemeral, &static_key)?;
        }
        let payload = self.sym.decrypt(&message[offset..])?;
        self.step += 1;
        if self.step == 3 {
            self.finish()?;
        }
        Ok(payload.to_vec())
    }

    pub fn is_finished(&self) -> bool {
        self.transport.is_some()
    }

    pub fn handshake_hash(&self) -> &[u8; 32] {
        &self.handshake_hash
    }

    pub fn remote_static(&self) -> Option<&[u8; 32]> {
        self.remote_static.as_ref()
    }

    /// The finished handshake's keys, taken out of a state the shell still owns.
    pub fn take_transport(&mut self) -> Result<SessionKeys, RelayError> {
        if self.failed {
            return Err(RelayError::Noise("Handshake closed"));
        }
        self.transport
            .take()
            .ok_or(RelayError::Noise("Handshake incomplete"))
    }

    pub fn into_transport(mut self) -> Result<SessionKeys, RelayError> {
        self.take_transport()
    }
}
