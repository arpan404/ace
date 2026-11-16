//! Spade has no spending limits (ADR 0166). Builds before it parked a task stopped by a cap
//! (`wake_set {purpose: park, reason: cap}`, ADR 0158) and a worker at its subtree budget
//! (`wait_for {condition: budget}`, ADR 0161). Such a wake found open when Spade opens is
//! cancelled, and its task carries on.

use std::sync::Arc;

use spade_core::wake::{self, CancelledBy};

use super::Engine;

impl Engine {
    /// When Spade opens, once the wakes are armed: every open cap or budget wake is cancelled and
    /// its conversation's task carries on.
    pub(super) fn retire_spend_parks(self: &Arc<Self>) {
        for (id, wake) in self.armed_where(|a| wake::for_spend(&a.open)) {
            match self.cancel_wake(&id, &wake, CancelledBy::Spade) {
                Ok(true) => self.carry_on(&id),
                Ok(false) => {}
                Err(error) => tracing::error!(%error, "could not cancel a wake set for spend"),
            }
        }
    }
}
