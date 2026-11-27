// SPDX-License-Identifier: Apache-2.0
//! Poll backoff (`poll.ts`): exponential from a base, capped, never sooner than the host's
//! `retryAt`.

/// Invalid polling limits, as the TypeScript's `RangeError`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
#[error("Invalid polling limits")]
pub struct InvalidPollLimits;

/// The wait before the next poll: `base * 2^failures`, capped, and at least until `retry_at`.
pub fn next_poll_delay(
    failures: u32,
    now: f64,
    retry_at: Option<f64>,
    base_ms: f64,
    max_ms: f64,
) -> Result<f64, InvalidPollLimits> {
    if !now.is_finite()
        || !base_ms.is_finite()
        || !max_ms.is_finite()
        || base_ms <= 0.0
        || max_ms < base_ms
    {
        return Err(InvalidPollLimits);
    }
    let exponential = max_ms.min(base_ms * 2f64.powi(failures.min(20) as i32));
    let wait = match retry_at {
        Some(retry_at) => exponential.max((retry_at - now).max(0.0)),
        None => exponential,
    };
    Ok(wait)
}

#[cfg(test)]
mod tests {
    use super::{InvalidPollLimits, next_poll_delay};

    #[test]
    fn backoff_doubles_from_the_base_and_stops_at_the_cap() {
        assert_eq!(
            next_poll_delay(0, 0.0, None, 15_000.0, 300_000.0).unwrap(),
            15_000.0
        );
        assert_eq!(
            next_poll_delay(2, 0.0, None, 15_000.0, 300_000.0).unwrap(),
            60_000.0
        );
        assert_eq!(
            next_poll_delay(20, 0.0, None, 15_000.0, 300_000.0).unwrap(),
            300_000.0
        );
        assert_eq!(
            next_poll_delay(u32::MAX, 0.0, None, 15_000.0, 300_000.0).unwrap(),
            300_000.0
        );
    }

    #[test]
    fn a_host_deadline_is_never_polled_sooner() {
        assert_eq!(
            next_poll_delay(0, 1_000.0, Some(1_000.0 + 120_000.0), 15_000.0, 300_000.0).unwrap(),
            120_000.0
        );
        assert_eq!(
            next_poll_delay(0, 1_000.0, Some(500.0), 15_000.0, 300_000.0).unwrap(),
            15_000.0
        );
    }

    #[test]
    fn invalid_limits_are_refused() {
        assert_eq!(
            next_poll_delay(0, 0.0, None, 0.0, 300_000.0),
            Err(InvalidPollLimits)
        );
        assert_eq!(
            next_poll_delay(0, 0.0, None, 10.0, 5.0),
            Err(InvalidPollLimits)
        );
        assert_eq!(
            next_poll_delay(0, f64::NAN, None, 10.0, 5.0),
            Err(InvalidPollLimits)
        );
    }
}
