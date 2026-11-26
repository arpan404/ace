// SPDX-License-Identifier: Apache-2.0
//! The call slots `ToolRegistry` bounds: 1,024 calls in all and 256 per thread
//! (`registry.ts:245`–`:246`, `:526`–`:545`). A slot is taken before anything is awaited, so
//! calls started together each see the ones before them.

use std::collections::HashMap;

use crate::limits::{MAX_CALLS, MAX_CALLS_PER_THREAD};

/// One registry's running calls, by thread.
#[derive(Debug, Clone)]
pub struct Calls {
    max_calls: usize,
    max_calls_per_thread: usize,
    active: usize,
    threads: HashMap<String, usize>,
}

impl Default for Calls {
    fn default() -> Self {
        Calls::new(MAX_CALLS, MAX_CALLS_PER_THREAD)
    }
}

impl Calls {
    pub fn new(max_calls: usize, max_calls_per_thread: usize) -> Self {
        Self {
            max_calls,
            max_calls_per_thread,
            active: 0,
            threads: HashMap::new(),
        }
    }

    /// Whether one more call may start for `thread`.
    pub fn admits(&self, thread: &str) -> bool {
        self.active < self.max_calls
            && self.threads.get(thread).copied().unwrap_or(0) < self.max_calls_per_thread
    }

    /// Takes a slot for `thread`; false when a limit is reached, and nothing is taken.
    pub fn take(&mut self, thread: &str) -> bool {
        if !self.admits(thread) {
            return false;
        }
        self.active += 1;
        *self.threads.entry(thread.to_owned()).or_insert(0) += 1;
        true
    }

    /// Gives a slot back.
    pub fn release(&mut self, thread: &str) {
        let Some(count) = self.threads.get_mut(thread) else {
            return;
        };
        *count -= 1;
        if *count == 0 {
            self.threads.remove(thread);
        }
        self.active = self.active.saturating_sub(1);
    }

    pub fn active(&self) -> usize {
        self.active
    }

    pub fn active_for(&self, thread: &str) -> usize {
        self.threads.get(thread).copied().unwrap_or(0)
    }
}

#[cfg(test)]
mod tests {
    // Ported from `admission.process.test.ts`: "rejects excess tools work before effects and
    // admits work after completion", for the slot accounting it guards.
    use super::*;

    #[test]
    fn a_call_past_the_total_limit_is_refused_until_one_finishes() {
        let mut calls = Calls::new(1, 8);
        assert!(calls.take("thread"));
        assert!(!calls.take("other"));
        calls.release("thread");
        assert!(calls.take("other"));
        assert_eq!(calls.active(), 1);
    }

    #[test]
    fn a_threads_own_limit_is_independent_of_another_threads() {
        let mut calls = Calls::new(8, 1);
        assert!(calls.take("thread"));
        assert!(!calls.take("thread"));
        assert!(calls.take("other"));
        assert_eq!(calls.active_for("thread"), 1);
        calls.release("thread");
        assert!(calls.take("thread"));
        assert_eq!(calls.active(), 2);
    }

    #[test]
    fn a_release_below_zero_or_for_an_unknown_thread_changes_nothing() {
        let mut calls = Calls::default();
        calls.release("thread");
        assert_eq!(calls.active(), 0);
        assert!(calls.take("thread"));
        calls.release("other");
        assert_eq!(calls.active(), 1);
    }
}
