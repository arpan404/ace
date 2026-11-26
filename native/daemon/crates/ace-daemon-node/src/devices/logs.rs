// SPDX-License-Identifier: Apache-2.0
//! The log binding (D3.3, U5): one rendered log line, and the clamp a read's limit takes. The
//! ring and its batches are per line, so they stay the shell's until the all-Rust daemon runs
//! `ace-devices`' `logs` in-process.

use ace_devices::platform::{log_line, logs};
use napi_derive::napi;

use super::answered;

/// `deviceLogLine`: simctl's envelope as a readable line, or the line as it came.
#[napi]
pub fn device_log_line(line: String) -> napi::Result<String> {
    answered(|| Ok(log_line::device_log_line(&line)))
}

/// The number of lines a read shows: `Math.max(1, Math.min(256, Math.trunc(limit)))`.
#[napi]
pub fn device_logs_tail_limit(limit: f64) -> u32 {
    logs::clamp_tail(limit) as u32
}
