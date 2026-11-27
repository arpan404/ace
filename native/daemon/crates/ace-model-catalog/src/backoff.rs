// SPDX-License-Identifier: Apache-2.0
//! One bounded retry schedule per source (`discovery-backoff.ts`).
//!
//! A shared catalog waits for every failing source, so the schedule is kept per source
//! id: an unchanged failure backs off exponentially with the injected jitter, and a
//! source that starts succeeding is forgotten. The cap is 30 minutes.

use std::collections::BTreeMap;

use crate::failures::FailureCode;

/// The longest a source waits between attempts.
const MAX_DELAY_MS: f64 = 1_800_000.0;
/// The most sources one catalog tracks.
const MAX_SOURCES: usize = 512;
/// The most attempts that still change the delay.
const MAX_ATTEMPTS: u32 = 32;

#[derive(Debug, Clone)]
struct Failure {
    attempts: u32,
    code: FailureCode,
    base_ms: f64,
    retry_at: f64,
}

/// How a failure is reported and when the next attempt may run.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Schedule {
    pub retry_in_ms: f64,
    /// `true` when this is a new failure, a new code or a new base delay.
    pub warn: bool,
}

/// The failure state of every source of one instance.
#[derive(Debug, Default, Clone)]
pub struct DiscoveryBackoff {
    failures: BTreeMap<String, Failure>,
}

impl DiscoveryBackoff {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn reset(&mut self) {
        self.failures.clear();
    }

    /// Forget every source that did not fail in this refresh.
    pub fn retain(&mut self, sources: impl IntoIterator<Item = String>) {
        let kept: Vec<String> = sources.into_iter().collect();
        self.failures.retain(|source, _| kept.contains(source));
    }

    /// Records one failure and says when the source may be tried again.
    pub fn fail(
        &mut self,
        source: &str,
        code: FailureCode,
        now: f64,
        initial_ms: f64,
        jitter: f64,
    ) -> Result<Schedule, &'static str> {
        let previous = self.failures.get(source);
        let attempts = previous.map(|failure| failure.attempts).unwrap_or(0) + 1;
        let attempts = attempts.min(MAX_ATTEMPTS);
        let base = (initial_ms * 2f64.powi(attempts as i32 - 1)).min(MAX_DELAY_MS);
        let jittered = base * (0.8 + (0.0f64.max(1.0f64.min(jitter))) * 0.4);
        let delay = jittered.min(MAX_DELAY_MS).round();
        if previous.is_none() && self.failures.len() >= MAX_SOURCES {
            return Err("Discovery source limit reached");
        }
        let warn = previous.is_none_or(|failure| failure.code != code || failure.base_ms != base);
        self.failures.insert(
            source.to_owned(),
            Failure {
                attempts,
                code,
                base_ms: base,
                retry_at: now + delay,
            },
        );
        Ok(Schedule {
            retry_in_ms: delay,
            warn,
        })
    }

    /// When the last failing source may be tried again; zero with no failures.
    pub fn retry_at(&self) -> f64 {
        self.failures
            .values()
            .map(|failure| failure.retry_at)
            .fold(0.0, f64::max)
    }
}

#[cfg(test)]
mod tests {
    //! Ports `packages/models/src/discovery-backoff.process.test.ts`'s schedule:
    //! "each failing source backs off twice as long, capped at 30 minutes, and a
    //! healthy source drops out" (`catalog.process.test.ts`'s "failed refresh retains
    //! stale rows and cooldown prevents repeated probes").

    use super::*;

    #[test]
    fn each_attempt_doubles_the_delay_up_to_thirty_minutes() {
        let mut backoff = DiscoveryBackoff::new();
        let first = backoff
            .fail("a", FailureCode::Unreachable, 1_000.0, 30_000.0, 0.5)
            .unwrap_or_else(|error| panic!("{error}"));
        assert_eq!(first.retry_in_ms, 30_000.0);
        assert!(first.warn);
        let second = backoff
            .fail("a", FailureCode::Unreachable, 31_000.0, 30_000.0, 0.5)
            .unwrap_or_else(|error| panic!("{error}"));
        assert_eq!(second.retry_in_ms, 60_000.0);
        // A doubling base is a new schedule, which the TypeScript reports as `warn`.
        assert!(second.warn);
        assert_eq!(backoff.retry_at(), 31_000.0 + 60_000.0);
        for now in (100_000..2_000_000).step_by(120_000) {
            let _ = backoff.fail("a", FailureCode::Unreachable, now as f64, 30_000.0, 0.5);
        }
        assert_eq!(
            backoff
                .fail("a", FailureCode::Unreachable, 2_000_000.0, 30_000.0, 0.5)
                .map(|s| s.retry_in_ms),
            Ok(MAX_DELAY_MS)
        );
    }

    #[test]
    fn a_new_code_or_a_healthy_source_changes_what_is_kept() {
        let mut backoff = DiscoveryBackoff::new();
        let _ = backoff.fail("a", FailureCode::Unreachable, 0.0, 30_000.0, 0.5);
        let changed = backoff
            .fail("a", FailureCode::AuthExpired, 0.0, 30_000.0, 0.5)
            .unwrap_or_else(|error| panic!("{error}"));
        assert!(changed.warn);
        let _ = backoff.fail("b", FailureCode::ParseFailure, 0.0, 30_000.0, 0.5);
        backoff.retain(["b".to_owned()]);
        assert_eq!(backoff.retry_at(), 30_000.0);
        backoff.reset();
        assert_eq!(backoff.retry_at(), 0.0);
    }
}
