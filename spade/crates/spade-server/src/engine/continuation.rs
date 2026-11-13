//! Keeping a bot's task going (ADR 0144): when a reply ends with the task still `working`, Spade
//! starts the next step itself, as a normal turn opened by a short note. When, and when to stop,
//! is `spade_core::task::next`; this starts the step, waits out a backoff, and says when it
//! paused. Nothing waits across a restart: reopening asks again.

use std::sync::Arc;
use std::sync::atomic::Ordering;
use std::time::Duration;

use spade_core::Event;
use spade_core::event::Known;
use spade_core::task::{self, Next};

use super::Engine;

/// What the policy decided when a turn ended, taken while its worker still owned the
/// conversation.
pub(super) enum Planned {
    /// A step is registered under `token`: a Stop from now on calls it off.
    Continue {
        step: u32,
        due_ms: i64,
        token: String,
    },
    Pause {
        reason: task::PauseReason,
        steps: u32,
    },
}

/// How often a step waiting out its backoff looks at the clock again.
const LOOK_AGAIN: Duration = Duration::from_secs(1);

impl Engine {
    /// When Spade reopens: carries the bot's task on if it is still working.
    pub(super) fn carry_on(self: &Arc<Self>, id: &str) {
        if let Some(planned) = self.plan_carry_on(id) {
            self.carry_on_as(id, planned);
        }
    }

    /// Decides whether the bot's task carries on, now or after a backoff, or pauses. A step that
    /// will start is registered before this returns, so the turn's worker calls this before it
    /// lets go of the conversation: a Stop pressed at any point after it ends calls the step off.
    pub(super) fn plan_carry_on(&self, id: &str) -> Option<Planned> {
        if !self.may_continue(id) {
            return None;
        }
        let events = self.load(id).ok()?;
        match task::next(&events, &self.limits.task) {
            Next::Nothing => None,
            Next::Pause { reason, steps } => Some(Planned::Pause { reason, steps }),
            Next::Continue { step, after_ms } => {
                let token = self.ids.next("k");
                // Under the lock Stop takes, so a Stop that looked before this sees no step and
                // one that looks after it calls this one off.
                let _order = self.record_lock.lock().unwrap_or_else(|p| p.into_inner());
                if self.load(id).is_ok_and(|now| stop_since(&now, &events)) {
                    return None;
                }
                self.continuations
                    .lock()
                    .unwrap_or_else(|p| p.into_inner())
                    .insert(id.to_owned(), token.clone());
                Some(Planned::Continue {
                    step,
                    due_ms: self.now_ms() + after_ms.max(0),
                    token,
                })
            }
        }
    }

    /// Acts on what [`Engine::plan_carry_on`] decided: starts the step once its backoff is over
    /// by the engine's clock, or says once that the task paused.
    pub(super) fn carry_on_as(self: &Arc<Self>, id: &str, planned: Planned) {
        match planned {
            Planned::Pause { reason, steps } => {
                let _order = self.record_lock.lock().unwrap_or_else(|p| p.into_inner());
                // Said once, and only if nothing changed since it was decided.
                let still = self.load(id).is_ok_and(|now| {
                    matches!(task::next(&now, &self.limits.task), Next::Pause { .. })
                });
                if still
                    && let Err(error) =
                        self.append(id, &Event::Known(Known::TaskPaused { reason, steps }))
                {
                    tracing::error!(%error, "could not store that a task paused");
                }
            }
            Planned::Continue {
                step,
                due_ms,
                token,
            } => {
                self.announce(id);
                if self.now_ms() >= due_ms {
                    self.continue_now(id, step, &token);
                    return;
                }
                let (engine, id) = (self.clone(), id.to_owned());
                tokio::spawn(async move {
                    // Waits on the engine's clock, so a test moves time instead of waiting; a
                    // step called off meanwhile stops the wait.
                    loop {
                        let left = due_ms - engine.now_ms();
                        if left <= 0 {
                            break;
                        }
                        let left = Duration::from_millis(u64::try_from(left).unwrap_or(0));
                        tokio::time::sleep(left.min(LOOK_AGAIN)).await;
                        if !engine.is_planned(&id, &token) {
                            return;
                        }
                    }
                    engine.continue_now(&id, step, &token);
                });
            }
        }
    }

    fn is_planned(&self, id: &str, token: &str) -> bool {
        self.continuations
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .get(id)
            .is_some_and(|t| t == token)
    }

    /// Whether a step of the bot's task may start now: Spade is open, the bot is not being
    /// deleted, the person doesn't have its computer, and it is under every cap.
    fn may_continue(&self, id: &str) -> bool {
        self.admission.load(Ordering::SeqCst)
            && !self.deleting(id)
            && !self.held(id)
            && self.may_spend(id).is_ok()
    }

    /// Starts step `step` if it is still the one due and `token` is still the latest plan. Stored
    /// with its `reply_started`, so a restart never keeps the note without its step.
    fn continue_now(self: &Arc<Self>, id: &str, step: u32, token: &str) {
        let started = {
            let _order = self.record_lock.lock().unwrap_or_else(|p| p.into_inner());
            let current = {
                let mut pending = self.continuations.lock().unwrap_or_else(|p| p.into_inner());
                let current = pending.get(id).is_some_and(|t| t == token);
                if current {
                    pending.remove(id);
                }
                current
            };
            current
                && self.may_continue(id)
                && self.load(id).is_ok_and(|events| {
                    matches!(task::next(&events, &self.limits.task), Next::Continue { step: s, .. } if s == step)
                })
                && {
                    let note = Event::Known(Known::TaskContinued {
                        step,
                        nudge: task::nudge(step),
                    });
                    let opened = Event::reply_started(self.ids.next("r"), self.reply_model(id));
                    match self.append_events(id, &[note, opened]) {
                        Ok(_) => true,
                        Err(error) => {
                            tracing::error!(%error, "could not start the next step of a task");
                            false
                        }
                    }
                }
        };
        if started {
            self.spawn_turn(id);
        } else {
            self.announce(id);
        }
    }

    /// Forgets a step waiting to start; whether one was. The caller holds `record_lock`, so no
    /// step is registered or started meanwhile.
    pub(super) fn drop_continuation(&self, id: &str) -> bool {
        self.continuations
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .remove(id)
            .is_some()
    }

    /// Whether Spade is carrying the bot's task on: a step it started is running, or one waits to
    /// start.
    pub(crate) fn continuing(&self, id: &str, continued_reply_open: bool) -> bool {
        continued_reply_open
            || self
                .continuations
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .contains_key(id)
    }
}

/// Whether a stop was stored after `before` was read.
fn stop_since(now: &[Event], before: &[Event]) -> bool {
    now.iter()
        .skip(before.len())
        .any(|e| matches!(e, Event::Known(Known::StopRequested { .. })))
}
