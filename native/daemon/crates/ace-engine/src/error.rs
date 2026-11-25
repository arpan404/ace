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
