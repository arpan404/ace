// SPDX-License-Identifier: Apache-2.0
//! How long one device input may take (`packages/devices/src/input-budget.ts`): the
//! gesture itself, or Android's per-character typing, plus transport overhead.

use ace_json::JsString;

use crate::platform::device_input::DeviceInput;

/// The transport's own overhead on every input.
pub const INPUT_OVERHEAD_MS: f64 = 5_000.0;
/// Android's per-character typing budget.
pub const PER_CHARACTER_MS: f64 = 100.0;

/// `deviceInputTimeout`: a gesture keeps its own duration, typing is paced per
/// character, and everything else gets the overhead alone. `text.length` is
/// UTF-16 units, as JavaScript counts it.
pub fn device_input_timeout(input: &DeviceInput) -> f64 {
    let extra = match input {
        DeviceInput::Swipe { duration_ms, .. } | DeviceInput::LongPress { duration_ms, .. } => {
            *duration_ms
        }
        DeviceInput::Type { text } => utf16_len(text) as f64 * PER_CHARACTER_MS,
        _ => 0.0,
    };
    INPUT_OVERHEAD_MS + extra
}

/// `text.length`: UTF-16 code units, so an emoji counts twice.
fn utf16_len(text: &JsString) -> usize {
    text.len_utf16()
}

#[cfg(test)]
mod tests;
