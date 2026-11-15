//! A bot's task that a spending cap stopped waits for the cap's reset instead of being dropped
//! (ADR 0158, `spade_core::park`). It is stored as `task_parked`, so the bot reads as waiting with
//! the reason; at the reset, when the person raises the cap, or when Spade reopens, the task's
//! next step is planned again.

use std::sync::Arc;
use std::time::Duration;

use spade_core::event::{Event, Known};
use spade_core::oversight;
use spade_core::park::{self, ParkReason};

use super::Engine;
use super::continuation::LOOK_AGAIN;

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
        Some((
            Some(hit.resets_at),
            format!(
                "{} It carries on then, or as soon as the cap is raised.",
                oversight::refusal(&name, &hit)
            ),
        ))
    }

    /// Parks the bot's task: stores it once (unless the same park is already in effect), then
    /// plans the next step again at `until_ms`. A Stop or a new message calls the wait off.
    pub(super) fn park_task(self: &Arc<Self>, id: &str, until_ms: Option<i64>, why: &str) {
        let token = self.ids.next("k");
        {
            let _order = self.record_lock.lock().unwrap_or_else(|p| p.into_inner());
            let Ok(events) = self.load(id) else { return };
            let same =
                park::parked(events.iter()).is_some_and(|p| p.until_ms == until_ms && p.why == why);
            if !same
                && let Err(error) = self.append(
                    id,
                    &Event::Known(Known::TaskParked {
                        reason: ParkReason::Cap,
                        until_ms,
                        why: why.to_owned(),
                    }),
                )
            {
                tracing::error!(%error, "could not store that a task waits for its cap");
                return;
            }
            self.continuations
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .insert(id.to_owned(), token.clone());
        }
        self.announce(id);
        // Without a reset time, only a raised cap or a message carries it on.
        let Some(until_ms) = until_ms else { return };
        let (engine, id) = (self.clone(), id.to_owned());
        tokio::spawn(async move {
            // The engine's clock, so a test moves time instead of waiting.
            loop {
                let left = until_ms - engine.now_ms();
                if left <= 0 {
                    break;
                }
                let left = Duration::from_millis(u64::try_from(left).unwrap_or(0));
                tokio::time::sleep(left.min(LOOK_AGAIN)).await;
                if !engine.is_planned(&id, &token) {
                    return;
                }
            }
            engine.wake_parked(&id, &token);
        });
    }

    /// The person raised (or removed) a cap of `agent`'s: a task waiting for it carries on now.
    pub fn cap_changed(self: &Arc<Self>, agent: &str) {
        let Ok(Some(view)) = self.agent_view(agent) else {
            return;
        };
        let id = view.agent.conversation;
        let waiting = self
            .load(&id)
            .is_ok_and(|e| park::parked(e.iter()).is_some());
        if waiting {
            self.drop_parked(&id);
            self.carry_on(&id);
        }
    }

    fn wake_parked(self: &Arc<Self>, id: &str, token: &str) {
        let current = {
            let mut pending = self.continuations.lock().unwrap_or_else(|p| p.into_inner());
            let current = pending.get(id).is_some_and(|t| t == token);
            if current {
                pending.remove(id);
            }
            current
        };
        if current {
            self.carry_on(id);
        }
    }

    fn drop_parked(&self, id: &str) {
        let _order = self.record_lock.lock().unwrap_or_else(|p| p.into_inner());
        self.drop_continuation(id);
    }
}
