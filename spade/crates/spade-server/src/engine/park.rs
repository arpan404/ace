//! A bot's task that a spending cap stopped waits for the cap's reset instead of being dropped
//! (ADR 0158). The wait is a wake (`wake_set {purpose: park, reason: cap}`, ADR 0160), so it is
//! shown, kept across a restart and fired once like any other: at the reset, when the person
//! raises the cap, when Spade reopens with the cap lifted, or early by the person. A message
//! settles it (its reply meets the cap again if it still holds); Stop cancels it. When it fires
//! the task's next step, or its check of done, is planned again.

use std::sync::Arc;

use spade_core::oversight;
use spade_core::wake::{Cause, ParkReason, Purpose};

use super::Engine;

/// What a cap wake that fires because the cap no longer holds says happened.
const LIFTED: &str = "the spending cap no longer holds";

impl Engine {
    /// The cap that stops the conversation's next model call, as when it lifts and the words the
    /// person reads; `None` when it may spend.
    pub(super) fn cap_park(&self, id: &str) -> Option<(Option<i64>, String)> {
        if !self.within_cap().unwrap_or(false) {
            let until = self.periods().next_day;
            return Some((
                Some(until),
                "Today's spending cap for all bots is used up; it carries on after midnight."
                    .to_owned(),
            ));
        }
        let (name, hit) = self.bot_cap(id)?;
        // A worker's budget doesn't reset: it waits until it is raised (ADR 0161).
        let resets = (hit.scope != spade_core::event::CapScope::Budget).then_some(hit.resets_at);
        Some((
            resets,
            format!(
                "{} It carries on then, or as soon as the cap is raised.",
                oversight::refusal(&name, &hit)
            ),
        ))
    }

    /// Parks the bot's task on a cap until `until_ms`, unless it is parked on one already.
    pub(super) fn park_task(self: &Arc<Self>, id: &str, until_ms: Option<i64>, why: &str) {
        if !self.cap_wakes(id).is_empty() {
            return;
        }
        let purpose = Purpose::Park {
            reason: ParkReason::Cap,
            attempt: 0,
        };
        if let Err(error) = self.set_wake(id, purpose, until_ms, None, why) {
            tracing::error!(%error, "could not store that a task waits for its cap");
        }
    }

    /// The person raised (or removed) a cap of `agent`'s: a task waiting for it carries on now.
    pub fn cap_changed(self: &Arc<Self>, agent: &str) {
        let Ok(Some(view)) = self.agent_view(agent) else {
            return;
        };
        let id = view.agent.conversation;
        if self.cap_park(&id).is_none() {
            for wake in self.cap_wakes(&id) {
                self.fire_wake(&id, &wake, Cause::Condition, Some(LIFTED), Vec::new());
            }
        }
        // Its workers' caps count its spend too (ADR 0161).
        self.unpark_subtree(&id, LIFTED);
    }

    /// When Spade opens, once the wakes are armed: a task parked on a cap that was raised or
    /// removed meanwhile carries on.
    pub(super) fn unpark_lifted_caps(self: &Arc<Self>) {
        let parked = self.armed_where(|a| {
            matches!(
                a.open.purpose,
                Purpose::Park {
                    reason: ParkReason::Cap,
                    ..
                }
            )
        });
        for (id, wake) in parked {
            if self.cap_park(&id).is_none() {
                self.fire_wake(&id, &wake, Cause::Condition, Some(LIFTED), Vec::new());
            }
        }
    }

    /// The conversation's open cap wakes.
    fn cap_wakes(&self, id: &str) -> Vec<String> {
        self.wakes(id)
            .unwrap_or_default()
            .into_iter()
            .filter(|o| {
                matches!(
                    o.purpose,
                    Purpose::Park {
                        reason: ParkReason::Cap,
                        ..
                    }
                )
            })
            .map(|o| o.wake)
            .collect()
    }
}
