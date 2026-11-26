// SPDX-License-Identifier: Apache-2.0
//! The OpenCode session's sans-IO halves as they land: E3-opencode.1's event
//! stream and server core, then E3-opencode.2's tenant and E3-opencode.3's
//! recovery and HTTP effects.

pub mod admission;
pub mod ancestry;
pub mod api;
pub mod control;
pub mod coverage;
pub mod error;
pub mod evidence;
pub mod frames;
pub mod history;
pub mod http;
pub mod lookup;
pub mod model;
pub mod notes;
pub mod owned;
pub mod ownership;
pub mod recovery;
pub mod routes;
pub mod server;
pub mod stream;
pub mod tenant;

#[cfg(test)]
mod testing;

pub use coverage::covered_prefix;
pub use error::{SecretError, StreamError};
pub use evidence::RecoveryEvidence;
pub use routes::Routes;
pub use server::{ChunkOutcome, MAX_TENANTS, ServerCore, SubscribeError, Tenant, TenantId};
pub use stream::EventStream;
pub use tenant::{OpenCodeTenant, PendingInteraction, TenantConfig};
