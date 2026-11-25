// SPDX-License-Identifier: Apache-2.0
//! The engine errors and its lifecycle.

#[derive(Debug, thiserror::Error)]
pub enum EngineError {
    #[error("Invalid engine limit")]
    InvalidLimit,
    #[error("Invalid idleMs")]
    InvalidIdleMs,
    #[error("engine state is already borrowed")]
    Reentrant,
    #[error("NativeEngineIncomplete: {what} lands in {item}")]
    NotPorted {
        what: &'static str,
        item: &'static str,
    },
    #[error(transparent)]
    Port(#[from] ports::PortError),
    #[error(transparent)]
    Store(#[from] ace_store::Error),
    #[error("The provider isn't ready yet. Check its connection in Settings and try again.")]
    ProviderNotReady,
    #[error("{0}")]
    Registry(String),
    #[error("Engine starting")]
    Starting,
    #[error("Engine closing")]
    Closing,
    #[error("Engine closed")]
    Closed,
    /// A stored record, header or append the section's decoder refused (`records.ts:16`).
    #[error("Invalid snapshot record")]
    InvalidRecord,
    /// A stored thread state that is not the core's shape (`snapshot.ts:138`).
    #[error("Invalid saved core state")]
    InvalidState,
    /// The engine's record paths' own errors, and the store's message text.
    #[error("{0}")]
    Records(String),
    #[error("Missing engine state")]
    MissingState,
    /// A home this build cannot read (E5.3's version checks, `schema-version.ts:24`).
    /// The facade throws `IncompatibleDataError(store location, message, recovery)`.
    #[error("{message}")]
    Incompatible {
        message: String,
        recovery: &'static str,
    },
    #[error("Engine actor capacity exceeded")]
    ActorCapacityExceeded,
    #[error("acknowledgement reached with a transaction open")]
    NotOutermost,
    #[error("Invalid stored raw blob id")]
    InvalidRawBlobId,
    #[error("Invalid stored raw blob")]
    InvalidStoredRawBlob,
    #[error("Invalid stored attachment")]
    InvalidStoredAttachment,
}

impl EngineError {
    pub fn not_ported(what: &'static str, item: &'static str) -> EngineError {
        EngineError::NotPorted { what, item }
    }

    /// `skippableAtStartup` (`startup-skip.ts:9`): a busy or full store is retried, and data
    /// another ace build wrote refuses the whole home; any other unreadable thread is reported
    /// and skipped so the rest still recover.
    pub fn skippable_at_startup(&self) -> bool {
        match self {
            EngineError::Incompatible { .. } => false,
            // SQLITE_BUSY (5), SQLITE_LOCKED (6) and SQLITE_FULL (13): `isStoreBusy`
            // (`store-busy.ts:4`) and disk-full are the retryable ones.
            EngineError::Store(error) => !matches!(error.code, 5 | 6 | 13),
            // `isStoreRetry` also retries the store's own busy signal and a pinned live batch
            // that is still retrying (`LiveWriteRetry`), which reach Rust as port errors.
            EngineError::Port(crate::ports::PortError::Threw(message)) => {
                !(message == "Store is busy" || message.contains("Live writes are retrying"))
            }
            _ => true,
        }
    }

    /// The error class the binding puts on the JS error, such as `ACE_ENGINE_CLOSED`.
    pub fn code(&self) -> Option<&'static str> {
        match self {
            EngineError::Closed => Some("ACE_ENGINE_CLOSED"),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum Lifecycle {
    #[default]
    Starting,
    Ready,
    Closing,
    Closed,
}

use crate::ports;

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ports::PortError;

    #[test]
    fn a_busy_store_or_a_retrying_live_batch_is_not_skipped_at_startup() {
        // `isStoreRetry` (`store-busy.ts`): the store's own busy signal and a pinned live batch
        // that is retrying are contended, not damaged, so startup reports them.
        assert!(
            !EngineError::Port(PortError::Threw("Store is busy".to_owned())).skippable_at_startup()
        );
        assert!(
            !EngineError::Port(PortError::Threw(
                "Live writes are retrying a failed batch".to_owned()
            ))
            .skippable_at_startup()
        );
        assert!(
            EngineError::Port(PortError::Threw("a bad frame".to_owned())).skippable_at_startup()
        );
    }
}
