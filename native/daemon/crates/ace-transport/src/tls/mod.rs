// SPDX-License-Identifier: Apache-2.0
//! TLS termination for the remote listeners (T1b.1a): the identity bytes
//! TypeScript loads, the certificate an SNI-name resolver picks, the server
//! configuration, the handshake, and the process provider. Rust terminates
//! bytes here; TypeScript still decides every run-time question of remote
//! access (`remote-direct.ts`, `remote-policy.ts`).

pub mod config;
pub mod handshake;
pub mod identity;
pub mod provider;
pub mod resolver;

pub use config::server_config;
pub use handshake::{Accepted, accept};
pub use identity::TlsIdentity;
pub use provider::process_provider;
pub use resolver::SniResolver;

#[cfg(test)]
pub(crate) mod tests;
