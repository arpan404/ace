// SPDX-License-Identifier: Apache-2.0
//! Noise XX (`-> e; <- e, ee, s, es; -> s, se`), as the relay's streams run it, with the pinned
//! host id checked the moment the responder's static key arrives.

use snow::{Builder, HandshakeState};

use super::{Ephemeral, KeyPair, MAX_MESSAGE, SessionKeys, XX_PROTOCOL, host_id, params};
use crate::error::RelayError;

/// Noise XX (`-> e; <- e, ee, s, es; -> s, se`), as the relay's streams run it.
pub struct NoiseXx {
    state: HandshakeState,
    initiator: bool,
    pinned: Option<String>,
    step: u8,
    failed: bool,
}

impl NoiseXx {
    /// The client: knows the pinned host id, and checks the daemon's static key the moment it
    /// arrives.
    pub fn initiator(
        static_key: &KeyPair,
        ephemeral: Ephemeral,
        prologue: &[u8],
        pinned: Option<&str>,
    ) -> Result<Self, RelayError> {
        let fixed = match ephemeral {
            Ephemeral::Fresh => None,
            Ephemeral::Fixed(private) => Some(private),
        };
        let mut builder = Builder::new(params(XX_PROTOCOL)?)
            .local_private_key(&static_key.private)
            .map_err(|_| RelayError::Noise("Invalid static private key"))?;
        if let Some(private) = &fixed {
            builder = builder.fixed_ephemeral_key_for_testing_only(private);
        }
        let state = builder
            .prologue(prologue)
            .map_err(|_| RelayError::Noise("Noise prologue refused"))?
            .build_initiator()
            .map_err(|_| RelayError::Noise("Noise could not build a handshake"))?;
        Ok(Self {
            state,
            initiator: true,
            pinned: pinned.map(str::to_owned),
            step: 0,
            failed: false,
        })
    }

    /// The daemon: its static key is the identity the client pinned.
    pub fn responder(
        static_key: &KeyPair,
        ephemeral: Ephemeral,
        prologue: &[u8],
    ) -> Result<Self, RelayError> {
        let fixed = match ephemeral {
            Ephemeral::Fresh => None,
            Ephemeral::Fixed(private) => Some(private),
        };
        let mut builder = Builder::new(params(XX_PROTOCOL)?)
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
            pinned: None,
            step: 0,
            failed: false,
        })
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

    fn fail(&mut self) -> RelayError {
        self.failed = true;
        RelayError::Noise("Handshake closed")
    }

    pub fn write_message(&mut self, payload: &[u8]) -> Result<Vec<u8>, RelayError> {
        self.check(true)?;
        let overhead = match self.step {
            0 => 32,
            1 => 96,
            _ => 64,
        };
        if payload.len() + overhead > MAX_MESSAGE {
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
        let minimum = match self.step {
            0 => 32,
            1 => 96,
            _ => 64,
        };
        if message.len() < minimum || message.len() > MAX_MESSAGE {
            return Err(RelayError::Noise("Invalid Noise message size"));
        }
        let mut out = vec![0u8; MAX_MESSAGE];
        let payload = match self.state.read_message(message, &mut out) {
            Ok(len) => {
                out.truncate(len);
                out
            }
            Err(_) => return Err(self.fail()),
        };
        // The responder's static key arrived with this message: a pin that doesn't match ends the
        // handshake before the payload is handed to anyone.
        if self.step == 1
            && let Some(pinned) = &self.pinned
        {
            let static_key = self.state.get_remote_static().unwrap_or_default().to_vec();
            if host_id(&static_key) != *pinned {
                self.failed = true;
                return Err(RelayError::Noise("Pinned fingerprint mismatch"));
            }
        }
        self.step += 1;
        Ok(payload)
    }

    pub fn is_finished(&self) -> bool {
        self.state.is_handshake_finished()
    }

    pub fn handshake_hash(&self) -> &[u8] {
        self.state.get_handshake_hash()
    }

    pub fn remote_static(&self) -> Option<&[u8]> {
        self.state.get_remote_static()
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
