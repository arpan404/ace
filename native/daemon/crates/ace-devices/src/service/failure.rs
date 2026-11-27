// SPDX-License-Identifier: Apache-2.0
//! Turning any error into the `DeviceFailure` a client sees
//! (`packages/devices/src/failure.ts`).

use super::screen_failure::{ScreenError, screen_failure};
use crate::error::{
    DeviceError, DeviceFailure, GENERIC_HINT, MAX_FAILURE_TEXT_UTF16, truncate_utf16,
};

/// What failed, as the shell has it.
#[derive(Debug, Clone, Copy)]
pub enum Failed<'a> {
    /// One of ace's own typed refusals.
    Device(&'a DeviceError),
    /// Another JavaScript error: its message, and its `code` when it had one.
    Error(ScreenError<'a>),
    /// A thrown value that is not an `Error` at all.
    Unknown,
}

/// `deviceFailure`: ace's own code and words, a screen helper's mapped refusal,
/// or `command_failed` with today's text.
pub fn device_failure(failed: Failed<'_>) -> DeviceFailure {
    match failed {
        Failed::Device(error) => error.to_failure(None),
        Failed::Error(error) => match screen_failure(&error) {
            Some(known) => known.to_failure(None),
            None => DeviceFailure {
                code: crate::error::DeviceErrorCode::CommandFailed,
                message: truncate_utf16(&error.message.into(), MAX_FAILURE_TEXT_UTF16),
                hint: GENERIC_HINT.into(),
                permission: None,
                platform: None,
            },
        },
        Failed::Unknown => DeviceFailure {
            code: crate::error::DeviceErrorCode::CommandFailed,
            message: "Device operation failed".into(),
            hint: GENERIC_HINT.into(),
            permission: None,
            platform: None,
        },
    }
}

#[cfg(test)]
mod tests;
