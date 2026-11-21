//! Keeping a bot's task going (ADR 0144): when a reply ends with the task still `working`, Spade
//! starts the next step itself, as a normal turn opened by a short note. When, and when to stop,
//! is `spade_core::task::next`; this starts the step, waits out a backoff, and says when it
//! paused. Nothing waits across a restart: reopening asks again.

use std::sync::Arc;
use std::sync::atomic::Ordering;
use std::time::Duration;

use spade_core::Event;
use spade_core::event::Known;
use spade_core::goal::verify::{self, Claim};
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
    /// The bot claimed done with a goal open (ADR 0159): a verifier checks the claim first,
    /// registered under `token` like a step, so a Stop calls it off.
    Verify { claim: String, token: String },
}

/// How often a step waiting out its backoff looks at the clock again.
pub(super) const LOOK_AGAIN: Duration = Duration::from_secs(1);

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
        if !self.may_start_step(id) {
            return None;
        }
        let mut events = self.load(id).ok()?;
        if self.give_up_routine_goal(id, &events) {
            return None;
        }
        // A claim of done is checked before anything else (ADR 0159).
        match verify::claim(&events) {
            Claim::None => {}
            Claim::Settled(verdict) => {
                let _order = self.record_lock.lock().unwrap_or_else(|p| p.into_inner());
                let now = self.load(id).ok()?;
                if stop_since(&now, &events) {
                    return None;
                }
                if let Err(error) = self.append(id, &Event::Known(*verdict)) {
                    tracing::error!(%error, "could not store a task's check");
                    return None;
                }
                events = self.load(id).ok()?;
                drop(_order);
                if self.give_up_routine_goal(id, &events) {
                    return None;
                }
            }
            Claim::Check { claim, .. } => {
                let token = self.ids.next("k");
                let _order = self.record_lock.lock().unwrap_or_else(|p| p.into_inner());
                if self.load(id).is_ok_and(|now| stop_since(&now, &events)) {
                    return None;
                }
                self.continuations
                    .lock()
                    .unwrap_or_else(|p| p.into_inner())
                    .insert(id.to_owned(), token.clone());
                return Some(Planned::Verify { claim, token });
            }
        }
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

    /// Ends a verified routine's goal as failed once its check said "not yet" too often (ADR 0204
    /// §3): its run never reads done, and nothing carries it on. Whether it ended it.
    fn give_up_routine_goal(&self, id: &str, events: &[Event]) -> bool {
        let Some(ended) = verify::gave_up(events) else {
            return false;
        };
        let _order = self.record_lock.lock().unwrap_or_else(|p| p.into_inner());
        let still = self
            .load(id)
            .is_ok_and(|now| verify::gave_up(&now).is_some());
        if still && let Err(error) = self.append(id, &Event::Known(ended)) {
            tracing::error!(%error, "could not end a routine's goal");
        }
        drop(_order);
        self.remember_episodes(id);
        self.announce(id);
        true
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
            Planned::Verify { claim, token } => {
                self.set_status(id, Some(super::goals::VERIFYING.to_owned()));
                let (engine, id) = (self.clone(), id.to_owned());
                tokio::spawn(async move {
                    engine.verify_claim(&id, &claim, &token).await;
                });
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

    pub(super) fn is_planned(&self, id: &str, token: &str) -> bool {
        self.continuations
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .get(id)
            .is_some_and(|t| t == token)
    }

    /// Whether a step of the bot's task may start now: Spade is open, the bot is not being
    /// deleted, and the person neither has its computer nor paused it. Spend never stops it
    /// (ADR 0166).
    fn may_start_step(&self, id: &str) -> bool {
        self.admission.load(Ordering::SeqCst) && !self.deleting(id) && !self.closed(id)
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
            let due = if current && self.may_start_step(id) {
                self.load(id).ok().filter(|events| {
                    matches!(task::next(events, &self.limits.task), Next::Continue { step: s, .. } if s == step)
                })
            } else {
                None
            };
            due.is_some_and(|events| {
                // What the goal's check found missing, and where the plan resumes (ADR 0159).
                let nudge = format!("{}{}", task::nudge(step), verify::nudge_tail(&events));
                let note = Event::Known(Known::TaskContinued { step, nudge });
                let opened = Event::reply_started(self.ids.next("r"), self.reply_model(id));
                match self.append_events(id, &[note, opened]) {
                    Ok(_) => true,
                    Err(error) => {
                        tracing::error!(%error, "could not start the next step of a task");
                        false
                    }
                }
            })
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
