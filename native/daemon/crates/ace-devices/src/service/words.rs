// SPDX-License-Identifier: Apache-2.0
//! The service's refusals, read from the one catalog
//! (`native/daemon/catalog/devices.json`, ADR 0225 safeguard 3) that the
//! TypeScript and Rust both read. No message or hint is retyped here.
//!
//! The catalog's one reader is [`crate::platform::words`]; this module only
//! turns its word into the crate's typed [`DeviceError`].

use crate::error::{DeviceError, DeviceErrorCode};

/// The refusal `key` names, as the crate's typed error.
pub fn refusal(key: &str) -> DeviceError {
    let word = crate::platform::words::refusal(key);
    DeviceError::coded(
        DeviceErrorCode::parse(word.code.as_str()).unwrap_or(DeviceErrorCode::CommandFailed),
        word.message,
        word.hint,
    )
}

/// The next step of a refusal whose message is data (an element's name, a
/// device's name): the catalog still owns the hint.
pub fn hint(key: &str) -> &'static str {
    crate::platform::words::platform_hint(key)
}

/// A `tools` word: a hint that is not a whole refusal, for a message this crate
/// builds (the screen helper's foreground refusal).
pub fn tool_hint(key: &str) -> &'static str {
    crate::platform::words::tool_hint(key)
}
