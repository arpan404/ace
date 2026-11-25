// SPDX-License-Identifier: Apache-2.0
//! The OpenCode session's sans-IO halves as they land: E3-opencode.1's event
//! stream and server core, then E3-opencode.2's tenant and E3-opencode.3's
//! recovery and HTTP effects.

pub mod error;
pub mod notes;
pub mod ownership;
pub mod routes;
pub mod server;
pub mod stream;

#[cfg(test)]
mod testing;

pub use error::{SecretError, StreamError};
pub use routes::Routes;
pub use server::{ChunkOutcome, MAX_TENANTS, ServerCore, SubscribeError, Tenant, TenantId};
pub use stream::EventStream;
