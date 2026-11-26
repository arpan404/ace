// SPDX-License-Identifier: Apache-2.0
//! Delivery (E5.5): the pure rules around an intent's turn (`origin`, `root_run_start`,
//! `resolution`), and the two entry points the sends lane calls. Taking an intent to the
//! provider needs E5.6's sessions and E5.9's transitions, so `run` and `fail` still throw
//! `NotPorted`; the worker set reports it once and the intent stays where it was.

use crate::intents::header::IntentHeader;
use crate::{Core, EngineError};

pub mod origin;
pub mod resolution;
pub mod root_run_start;

/// `delivery.run`: claim an intent and take it to the provider (E5.5).
pub fn run(core: &Core, intent: &IntentHeader) -> Result<(), EngineError> {
    let _ = (core, intent);
    Err(EngineError::not_ported("a delivery", "E5.5"))
}

/// `delivery.fail`: mark an intent failed with a reason a person reads (E5.5).
pub fn fail(core: &Core, intent: &IntentHeader, reason: &str) -> Result<(), EngineError> {
    let _ = (core, intent, reason);
    Err(EngineError::not_ported("a failed delivery", "E5.5"))
}
