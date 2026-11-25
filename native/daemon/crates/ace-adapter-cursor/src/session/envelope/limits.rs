// SPDX-License-Identifier: Apache-2.0
//! `Limits` (`contracts.ts:17`-`:30`): the launch's bounds, their defaults and the strict key set
//! `z.strictObject` enforces. Every value is an integer in its range, as `z.number().int()` and
//! the schema's guards require.

use ace_json::{Map, Value};

use super::super::error::SessionError;
use super::is_integer;

/// The limits' keys, in the schema's order (`contracts.ts:18`-`:29`); the object is strict.
const LIMIT_KEYS: [&str; 13] = [
    "maxWorkers",
    "maxFrameBytes",
    "maxPendingBytes",
    "maxCallbacks",
    "maxIdentities",
    "maxInputBytes",
    "maxCheckpointBytes",
    "historyPageSize",
    "heapMb",
    "timeoutMs",
    "sendTimeoutMs",
    "ackTimeoutMs",
    "graceMs",
];

/// The cursor's `Limits`, after `Limits.parse` filled its defaults (`contracts.ts:17`-`:30`).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct CursorLimits {
    pub max_workers: u32,
    pub max_frame_bytes: usize,
    pub max_pending_bytes: usize,
    pub max_callbacks: u32,
    pub max_identities: u32,
    pub max_input_bytes: usize,
    pub max_checkpoint_bytes: u64,
    pub history_page_size: u32,
    pub heap_mb: u32,
    pub timeout_ms: f64,
    pub send_timeout_ms: f64,
    pub ack_timeout_ms: f64,
    pub grace_ms: f64,
}

impl Default for CursorLimits {
    fn default() -> CursorLimits {
        CursorLimits {
            max_workers: 8,
            max_frame_bytes: 1_048_576,
            max_pending_bytes: 2_097_152,
            max_callbacks: 32,
            max_identities: 2_048,
            max_input_bytes: 262_144,
            max_checkpoint_bytes: 8_589_934_592,
            history_page_size: 100,
            heap_mb: 2_048,
            timeout_ms: 30_000.0,
            send_timeout_ms: 300_000.0,
            ack_timeout_ms: 300_000.0,
            grace_ms: 5_000.0,
        }
    }
}

/// `Limits.parse(value)` (`contracts.ts:17`-`:30`): every default, every bound, strict keys.
pub fn limits(value: &Value) -> Result<CursorLimits, SessionError> {
    let object = value
        .as_object()
        .ok_or_else(|| SessionError::Limits("not an object".into()))?;
    for key in object.keys() {
        if !LIMIT_KEYS.contains(&key.as_str()) {
            return Err(SessionError::Limits(format!("unknown limit {key}")));
        }
    }
    let defaults = CursorLimits::default();
    let mut parsed = defaults;
    parsed.max_workers = limit_integer(object, "maxWorkers", 1.0, 64.0)?
        .unwrap_or(defaults.max_workers as f64) as u32;
    parsed.max_frame_bytes = limit_integer(object, "maxFrameBytes", 4_096.0, 1_048_576.0)?
        .unwrap_or(defaults.max_frame_bytes as f64) as usize;
    parsed.max_pending_bytes = limit_integer(object, "maxPendingBytes", 4_096.0, 8_388_608.0)?
        .unwrap_or(defaults.max_pending_bytes as f64) as usize;
    parsed.max_callbacks = limit_integer(object, "maxCallbacks", 1.0, 256.0)?
        .unwrap_or(defaults.max_callbacks as f64) as u32;
    parsed.max_identities = limit_integer(object, "maxIdentities", 1.0, 8_192.0)?
        .unwrap_or(defaults.max_identities as f64) as u32;
    parsed.max_input_bytes = limit_integer(object, "maxInputBytes", 1.0, 524_288.0)?
        .unwrap_or(defaults.max_input_bytes as f64) as usize;
    parsed.max_checkpoint_bytes =
        limit_integer(object, "maxCheckpointBytes", 1.0, 68_719_476_736.0)?
            .unwrap_or(defaults.max_checkpoint_bytes as f64) as u64;
    parsed.history_page_size = limit_integer(object, "historyPageSize", 1.0, 200.0)?
        .unwrap_or(defaults.history_page_size as f64) as u32;
    parsed.heap_mb =
        limit_integer(object, "heapMb", 64.0, 8_192.0)?.unwrap_or(defaults.heap_mb as f64) as u32;
    parsed.timeout_ms =
        limit_integer(object, "timeoutMs", 1.0, 300_000.0)?.unwrap_or(defaults.timeout_ms);
    parsed.send_timeout_ms =
        limit_integer(object, "sendTimeoutMs", 1.0, 600_000.0)?.unwrap_or(defaults.send_timeout_ms);
    parsed.ack_timeout_ms =
        limit_integer(object, "ackTimeoutMs", 1.0, 600_000.0)?.unwrap_or(defaults.ack_timeout_ms);
    parsed.grace_ms = limit_integer(object, "graceMs", 0.0, 30_000.0)?.unwrap_or(defaults.grace_ms);
    Ok(parsed)
}

fn limit_integer(object: &Map, key: &str, min: f64, max: f64) -> Result<Option<f64>, SessionError> {
    match object.get(key) {
        None => Ok(None),
        Some(Value::Number(number)) => {
            let value = number.value();
            if is_integer(value) && value >= min && value <= max {
                Ok(Some(value))
            } else {
                Err(SessionError::Limits(format!(
                    "{key} is not an integer from {min} to {max}"
                )))
            }
        }
        Some(_) => Err(SessionError::Limits(format!("{key} is not a number"))),
    }
}
