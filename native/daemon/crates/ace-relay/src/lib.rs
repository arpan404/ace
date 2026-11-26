// SPDX-License-Identifier: Apache-2.0
//! The daemon's side of the relay (ADR 0155, docs/transport/porting-guide.md T6): what an NK first
//! message may cost before its client confirms, the early reads it may ask for, its host admission,
//! the relayed channel seen as a socket, and the Noise handshakes that carry all of it.
//!
//! The relay's wire and its hosted server are not here: this crate is the daemon's client of a
//! relay and its host half. Tests never contact the hosted relay; a local server stands in.

pub mod error;
pub mod nk;

pub use error::RelayError;
pub use nk::admission::{NK_LIMITS, NkAdmission, NkClock, NkLimits, NkSession, Rate, Suppression};
