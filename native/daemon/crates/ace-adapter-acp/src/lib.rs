// SPDX-License-Identifier: Apache-2.0
//! The acp adapter (ADR 0223 section 2). E0 declares the modules; E1 ports the
//! translator closure into translate, E3 the session into session.

pub mod error;
pub mod session;
pub mod translate;

pub use error::AcpError;
