// SPDX-License-Identifier: Apache-2.0
//! `thread.compact`: the switch to the provider's own compaction. Admission checks the provider
//! has one (`compact_supported`) and the thread is idle (`compact_idle`); the delivery asks the
//! session, whose `compact` reports through the provider's frames (a compaction item, the
//! `compacting` activity, then the summary). The context meter folds those events, so the meter
//! stands at unknown while the provider compacts.

use crate::ports::PortError;
use crate::{EngineError, sessions::observer};

/// `thread.compact`'s refusal: the provider has no native compaction.
pub const UNSUPPORTED_COMPACT: &str = "unsupported_compact";
/// `thread.compact`'s refusal: the provider can't compact while its agent works.
pub const THREAD_NOT_IDLE: &str = "thread_not_idle";

/// `thread.compact`'s admission against the provider's capabilities (`Capabilities.compaction`).
pub fn admit_capabilities(
    capabilities: &ace_protocol::generated::Capabilities,
    status: &str,
) -> Result<(), &'static str> {
    admit(capabilities.compaction, status)
}

/// Whether the command may go to the session: a provider with native compaction, an idle thread.
pub fn admit(compaction: Option<bool>, status: &str) -> Result<(), &'static str> {
    if !observer::compact_supported(compaction) {
        return Err(UNSUPPORTED_COMPACT);
    }
    if !observer::compact_idle(status) {
        return Err(THREAD_NOT_IDLE);
    }
    Ok(())
}

/// Asks the provider for its own compaction.
pub async fn compact(session: &dyn ace_adapter_api::Session) -> Result<(), EngineError> {
    session
        .compact()
        .await
        .map_err(|error| EngineError::Port(PortError::Threw(error.to_string())))
}

#[cfg(test)]
mod tests;
