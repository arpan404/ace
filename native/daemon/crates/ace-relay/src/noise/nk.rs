// SPDX-License-Identifier: Apache-2.0
//! Noise NK (`<- s; ...; -> e, es; <- e, ee`): the initiator knows the responder's static key in
//! advance, so its first message is already encrypted to it, and its ephemeral key is what replay
//! suppression remembers.

use snow::{Builder, HandshakeState};

use super::{
    Ephemeral, KeyPair, MAX_MESSAGE, NK_FIRST_MESSAGE_MINIMUM, NK_PROTOCOL, SessionKeys, params,
};
use crate::error::RelayError;

/// Noise NK (`<- s; ...; -> e, es; <- e, ee`): the initiator knows the responder's static key in
/// advance, so its first message is already encrypted to it.
pub struct NoiseNk {
    state: HandshakeState,
    initiator: bool,
    step: u8,
    failed: bool,
    remote_ephemeral: Option<[u8; 32]>,
}

impl NoiseNk {
    pub fn initiator(
        remote_static: &[u8],
        ephemeral: Ephemeral,
        prologue: &[u8],
    ) -> Result<Self, RelayError> {
        if remote_static.len() != 32 {
            return Err(RelayError::Noise("Invalid static public key"));
        }
        // The local static key is unused on the initiator's side of NK; snow still wants one, so
        // it gets a throwaway pair the handshake never sends.
        let local = KeyPair::from_private([0u8; 32]);
        let fixed = match ephemeral {
            Ephemeral::Fresh => None,
            Ephemeral::Fixed(private) => Some(private),
        };
        let mut builder = Builder::new(params(NK_PROTOCOL)?)
            .local_private_key(&local.private)
            .map_err(|_| RelayError::Noise("Invalid static private key"))?;
        if let Some(private) = &fixed {
            builder = builder.fixed_ephemeral_key_for_testing_only(private);
        }
        let state = builder
            .prologue(prologue)
            .map_err(|_| RelayError::Noise("Noise prologue refused"))?
            .remote_public_key(remote_static)
            .map_err(|_| RelayError::Noise("Invalid static public key"))?
            .build_initiator()
            .map_err(|_| RelayError::Noise("Noise could not build a handshake"))?;
        Ok(Self {
            state,
            initiator: true,
            step: 0,
            failed: false,
            remote_ephemeral: None,
        })
    }

    pub fn responder(
        static_key: &KeyPair,
        ephemeral: Ephemeral,
        prologue: &[u8],
    ) -> Result<Self, RelayError> {
        let fixed = match ephemeral {
            Ephemeral::Fresh => None,
            Ephemeral::Fixed(private) => Some(private),
        };
        let mut builder = Builder::new(params(NK_PROTOCOL)?)
            .local_private_key(&static_key.private)
            .map_err(|_| RelayError::Noise("Invalid static private key"))?;
        if let Some(private) = &fixed {
            builder = builder.fixed_ephemeral_key_for_testing_only(private);
        }
        let state = builder
            .prologue(prologue)
            .map_err(|_| RelayError::Noise("Noise prologue refused"))?
            .build_responder()
            .map_err(|_| RelayError::Noise("Noise could not build a handshake"))?;
        Ok(Self {
            state,
            initiator: false,
            step: 0,
            failed: false,
            remote_ephemeral: None,
        })
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

    fn fail(&mut self) -> RelayError {
        self.failed = true;
        RelayError::Noise("Handshake closed")
    }

    pub fn write_message(&mut self, payload: &[u8]) -> Result<Vec<u8>, RelayError> {
        self.check(true)?;
        if payload.len() + NK_FIRST_MESSAGE_MINIMUM > MAX_MESSAGE {
            return Err(RelayError::Noise("Noise message too large"));
        }
        let mut out = vec![0u8; MAX_MESSAGE];
        match self.state.write_message(payload, &mut out) {
            Ok(len) => {
                out.truncate(len);
                self.step += 1;
                Ok(out)
            }
            Err(_) => Err(self.fail()),
        }
    }

    pub fn read_message(&mut self, message: &[u8]) -> Result<Vec<u8>, RelayError> {
        self.check(false)?;
        if message.len() < NK_FIRST_MESSAGE_MINIMUM || message.len() > MAX_MESSAGE {
            return Err(RelayError::Noise("Invalid Noise message size"));
        }
        // The first message's ephemeral key, remembered for replay suppression.
        if self.step == 0 && message.len() >= 32 {
            let mut ephemeral = [0u8; 32];
            ephemeral.copy_from_slice(&message[..32]);
            self.remote_ephemeral = Some(ephemeral);
        }
        let mut out = vec![0u8; MAX_MESSAGE];
        match self.state.read_message(message, &mut out) {
            Ok(len) => {
                out.truncate(len);
                self.step += 1;
                Ok(out)
            }
            Err(_) => Err(self.fail()),
        }
    }

    /// The first message's ephemeral key, once read: what replay suppression remembers.
    pub fn remote_ephemeral(&self) -> Option<[u8; 32]> {
        self.remote_ephemeral
    }

    pub fn is_finished(&self) -> bool {
        self.state.is_handshake_finished()
    }

    pub fn handshake_hash(&self) -> &[u8] {
        self.state.get_handshake_hash()
    }

    pub fn into_transport(self) -> Result<SessionKeys, RelayError> {
        if self.failed || !self.state.is_handshake_finished() {
            return Err(RelayError::Noise("Handshake incomplete"));
        }
        let transport = self
            .state
            .into_transport_mode()
            .map_err(|_| RelayError::Noise("Handshake incomplete"))?;
        Ok(SessionKeys { transport })
    }
}
