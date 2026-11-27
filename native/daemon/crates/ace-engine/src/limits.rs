// SPDX-License-Identifier: Apache-2.0
//! The engine's limits (E5.1): the bounds `engineLimits` holds, every value a safe integer at
//! least 1, resolved once when the engine is built.

use crate::EngineError;

/// The engine's bounds; the numbers behaviour.md §3, §4 and §8 make contract.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct EngineLimits {
    pub max_active_threads: u64,
    pub max_queued_frames: u64,
    pub max_queued_bytes: u64,
    pub max_frame_bytes: u64,
    pub max_pending_inputs: u64,
    pub max_input_bytes: u64,
}

impl Default for EngineLimits {
    fn default() -> EngineLimits {
        EngineLimits {
            max_active_threads: 64,
            // Intake pauses at 256 frames and resumes at 64; these are last-resort limits
            // for faulty adapters. An exhausted mailbox ends its session and can be resumed.
            max_queued_frames: 16_384,
            max_queued_bytes: 16 * 1024 * 1024,
            max_frame_bytes: 4 * 1024 * 1024,
            max_pending_inputs: 32,
            max_input_bytes: 262_144,
        }
    }
}

/// The raw numbers the facade passes: every JavaScript option as it arrived, unvalidated.
#[derive(Debug, Clone, Copy, Default)]
pub struct LimitOverrides {
    pub max_active_threads: Option<f64>,
    pub max_queued_frames: Option<f64>,
    pub max_queued_bytes: Option<f64>,
    pub max_frame_bytes: Option<f64>,
    pub max_pending_inputs: Option<f64>,
    pub max_input_bytes: Option<f64>,
}

/// The largest integer a JavaScript number holds exactly (`Number.isSafeInteger`).
const MAX_SAFE: f64 = 9_007_199_254_740_991.0;

fn count(value: f64) -> Option<u64> {
    if value.is_finite() && value.fract() == 0.0 && (1.0..=MAX_SAFE).contains(&value) {
        return Some(value as u64);
    }
    None
}

fn pick(value: Option<f64>, default: u64) -> Result<u64, EngineError> {
    match value {
        None => Ok(default),
        Some(value) => count(value).ok_or(EngineError::InvalidLimit),
    }
}

/// `engineLimits`: the defaults with the overrides applied, each validated.
pub fn resolve(input: LimitOverrides) -> Result<EngineLimits, EngineError> {
    let defaults = EngineLimits::default();
    Ok(EngineLimits {
        max_active_threads: pick(input.max_active_threads, defaults.max_active_threads)?,
        max_queued_frames: pick(input.max_queued_frames, defaults.max_queued_frames)?,
        max_queued_bytes: pick(input.max_queued_bytes, defaults.max_queued_bytes)?,
        max_frame_bytes: pick(input.max_frame_bytes, defaults.max_frame_bytes)?,
        max_pending_inputs: pick(input.max_pending_inputs, defaults.max_pending_inputs)?,
        max_input_bytes: pick(input.max_input_bytes, defaults.max_input_bytes)?,
    })
}

/// `idleMs`: a safe integer at least 0, else "Invalid idleMs".
pub fn validate_idle_ms(value: f64) -> Result<f64, EngineError> {
    if value.is_finite() && value.fract() == 0.0 && (0.0..=MAX_SAFE).contains(&value) {
        return Ok(value);
    }
    Err(EngineError::InvalidIdleMs)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_defaults_are_the_numbers_behaviour_md_names() {
        let limits = resolve(LimitOverrides::default()).expect("defaults");
        assert_eq!(
            limits,
            EngineLimits {
                max_active_threads: 64,
                max_queued_frames: 16_384,
                max_queued_bytes: 16 * 1024 * 1024,
                max_frame_bytes: 4 * 1024 * 1024,
                max_pending_inputs: 32,
                max_input_bytes: 262_144,
            }
        );
    }

    #[test]
    fn each_override_replaces_only_its_own_limit() {
        let limits = resolve(LimitOverrides {
            max_active_threads: Some(8.0),
            ..LimitOverrides::default()
        })
        .expect("override");
        assert_eq!(limits.max_active_threads, 8);
        assert_eq!(limits.max_queued_frames, 16_384);
    }

    #[test]
    fn every_invalid_limit_is_refused() {
        for value in [0.0, -1.0, 1.5, f64::NAN, f64::INFINITY, MAX_SAFE + 1.0] {
            assert!(matches!(
                resolve(LimitOverrides {
                    max_frame_bytes: Some(value),
                    ..LimitOverrides::default()
                }),
                Err(EngineError::InvalidLimit)
            ));
        }
    }

    #[test]
    fn idle_ms_is_a_safe_integer_at_least_zero() {
        assert!(matches!(validate_idle_ms(0.0), Ok(value) if value == 0.0));
        assert!(matches!(validate_idle_ms(30_000.0), Ok(value) if value == 30_000.0));
        for value in [-1.0, 1.5, f64::NAN, f64::INFINITY, MAX_SAFE + 1.0] {
            assert!(matches!(
                validate_idle_ms(value),
                Err(EngineError::InvalidIdleMs)
            ));
        }
    }
}
