// SPDX-License-Identifier: Apache-2.0

//! The seams a test needs to stop a mutation between two steps and look at what it did.
//!
//! Production calls [`reached`] and [`may_exchange`] too, and with the `test-hooks` feature off
//! they do nothing: no watch is installed and every exchange is available. A shipped crate must
//! never change what it does because a test binary is running beside it.

/// A point a test can stop a move at.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Step {
    /// The entry is at the staging name of a case-only move, before the second step.
    BetweenMoveSteps,
    /// The entry moved, before the guard that authorised the move is verified.
    AfterMove,
}

#[cfg(not(feature = "test-hooks"))]
/// Nothing watches: the step passes straight through.
pub(crate) fn reached(_step: Step, _from: &str, _to: &str) {}

#[cfg(all(not(feature = "test-hooks"), unix))]
/// No test refused it, so the atomic exchange is available.
pub(crate) fn may_exchange(_name: &str) -> bool {
    true
}

#[cfg(all(not(feature = "test-hooks"), unix))]
/// No test stood in for a volume that reports a case-only destination as taken.
pub(crate) fn reports_taken(_from: &str, _to: &str) -> bool {
    false
}

#[cfg(all(feature = "test-hooks", unix))]
pub(crate) use crate::test_hooks::{may_exchange, reports_taken};

#[cfg(feature = "test-hooks")]
pub(crate) use crate::test_hooks::reached;
