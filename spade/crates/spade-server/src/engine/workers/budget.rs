//! Budgets per subtree (ADR 0161). A worker's budget bounds what its whole subtree spends, and a
//! bot's daily and monthly caps (ADR 0135) count its subtree's spend: every model call is
//! admitted against each budget and cap on its path to the top of its tree. A subtree at its
//! budget waits on a wake (`wait_for {condition: budget}`) and carries on when it is raised.

use std::sync::Arc;

use spade_core::event::{CapScope, Known};
use spade_core::oversight::{self, Caps, Hit, Spent};
use spade_core::tree;
use spade_core::wake::{Cause, Condition, Purpose};
use spade_core::{Event, Transcript};
use spade_store::StoreError;

use super::super::Engine;

/// Who sets a budget the person changed.
pub(super) const PERSON: &str = "person";

impl Engine {
    /// The budget or cap that holds `conversation`'s next model call, counting `pending` micros
    /// as spent already: a budget of it or of a worker above it, or a cap of a bot above it (or of
    /// itself) counting everything under that bot. `None` for a bot with no tree.
    pub(crate) fn tree_cap(&self, conversation: &str, pending: u64) -> Option<(String, Hit)> {
        let agent = self.store.agent_for_conversation(conversation).ok()??;
        let mut path = vec![agent.conversation.clone()];
        path.extend(self.worker_ancestors(&agent.conversation));
        if path.len() == 1 && self.worker_children(&agent.conversation).is_empty() {
            return None;
        }
        let periods = self.periods();
        for node in path {
            let subtree = self.worker_subtree(&node);
            if let Some(budget) = self.worker_link(&node).and_then(|l| l.budget_micros) {
                let spent = self
                    .store
                    .spent_by_all(&subtree, 0)
                    .ok()?
                    .saturating_add(pending);
                if spent >= budget {
                    let name = self.agent_name(&node);
                    return Some((name, budget_hit(budget)));
                }
            }
            // A bot alone was checked against its own caps already.
            if subtree.len() == 1 {
                continue;
            }
            let Ok(Some(owner)) = self.store.agent_for_conversation(&node) else {
                continue;
            };
            let Ok(settings) = self.agent_oversight(&owner.id) else {
                continue;
            };
            let caps = Caps {
                daily_micros: settings.daily_cap_micros,
                monthly_micros: settings.monthly_cap_micros,
            };
            if caps == Caps::default() {
                continue;
            }
            let spent = Spent {
                today_micros: self
                    .store
                    .spent_by_all(&subtree, periods.day_start)
                    .ok()?
                    .saturating_add(pending),
                month_micros: self
                    .store
                    .spent_by_all(&subtree, periods.month_start)
                    .ok()?
                    .saturating_add(pending),
            };
            if let Some(hit) = oversight::hit(caps, spent, periods) {
                return Some((owner.name, hit));
            }
        }
        None
    }

    /// The name of the agent whose conversation is `conversation`.
    pub(super) fn agent_name(&self, conversation: &str) -> String {
        self.store
            .agent_for_conversation(conversation)
            .ok()
            .flatten()
            .map_or_else(|| "A worker".to_owned(), |a| a.name)
    }

    /// What `conversation`'s subtree has spent, all told.
    pub(super) fn subtree_spent(&self, conversation: &str) -> u64 {
        self.store
            .spent_by_all(&self.worker_subtree(conversation), 0)
            .unwrap_or(0)
    }

    /// Sets (or with `None` takes away) worker `worker`'s budget, stored in its conversation;
    /// a subtree waiting for budget that now has room carries on.
    pub(super) fn set_budget(
        self: &Arc<Self>,
        worker: &str,
        budget_micros: Option<u64>,
        by: &str,
    ) -> Result<(), StoreError> {
        let event = Event::Known(Known::WorkerBudget {
            budget_micros,
            by: by.to_owned(),
        });
        self.record(worker, &event)?;
        self.unpark_subtree(worker, "your budget was raised");
        Ok(())
    }

    /// Wakes each conversation in `id`'s subtree that waits for budget or a cap and may spend
    /// again now.
    pub(crate) fn unpark_subtree(self: &Arc<Self>, id: &str, what: &str) {
        for conversation in self.worker_subtree(id) {
            if self.bot_cap(&conversation).is_some() || !self.within_cap().unwrap_or(false) {
                continue;
            }
            let Ok(events) = self.load(&conversation) else {
                continue;
            };
            for wake in tree::budget_waits(&events) {
                self.fire_wake(
                    &conversation,
                    &wake,
                    Cause::Condition,
                    Some(what),
                    Vec::new(),
                );
            }
            if let Some(agent) = self.agent_of(&conversation) {
                // A task parked on a cap (ADR 0158) carries on too.
                self.cap_changed_here(&agent);
            }
        }
    }

    /// [`Engine::cap_changed`] for one agent, without walking its subtree again.
    fn cap_changed_here(self: &Arc<Self>, agent: &str) {
        let Ok(Some(view)) = self.agent_view(agent) else {
            return;
        };
        let id = view.agent.conversation;
        for open in self.wakes(&id).unwrap_or_default() {
            if matches!(
                open.purpose,
                Purpose::Park {
                    reason: spade_core::wake::ParkReason::Cap,
                    ..
                }
            ) && self.cap_park(&id).is_none()
            {
                self.fire_wake(
                    &id,
                    &open.wake,
                    Cause::Condition,
                    Some("the budget or cap no longer holds"),
                    Vec::new(),
                );
            }
        }
    }

    /// A worker whose reply closed at its budget, with nothing else holding it, waits for more
    /// budget instead of reading idle. Once: not while any wake is open.
    pub(super) fn park_on_budget(self: &Arc<Self>, id: &str) {
        let Ok(events) = self.load(id) else { return };
        let transcript = Transcript::fold(events.iter());
        if !tree::closed_at_budget(&events)
            || transcript.busy()
            || !transcript.wakes.is_empty()
            || self.continuing(id, false)
        {
            return;
        }
        let Some((name, hit)) = self.bot_cap(id) else {
            return;
        };
        if hit.scope != CapScope::Budget {
            return;
        }
        let why = oversight::refusal(&name, &hit);
        if let Err(error) = self.set_wake(id, Purpose::Wait, None, Some(Condition::Budget), &why) {
            tracing::error!(%error, "could not store that a worker waits for budget");
        }
    }
}

/// A budget reached: said once per budget, and never reset.
fn budget_hit(budget: u64) -> Hit {
    Hit {
        scope: CapScope::Budget,
        cap_micros: budget,
        period_start: i64::try_from(budget).unwrap_or(i64::MAX),
        resets_at: 0,
    }
}
