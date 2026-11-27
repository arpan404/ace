// SPDX-License-Identifier: Apache-2.0
//! E5.4f's two delivery stubs: execution is E5.5's. A delivery that would run throws
//! `NotPorted`, which the worker set reports once; the intent stays where it was.

use crate::intents::header::IntentHeader;
use crate::{Core, EngineError};

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
